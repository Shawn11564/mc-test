package io.mctest.agent.bukkit.fixtures;

import com.google.gson.JsonObject;
import io.mctest.agent.bukkit.MainThread;
import io.mctest.agent.bukkit.Params;
import io.mctest.agent.core.Errors;
import io.mctest.agent.core.McTestException;
import io.mctest.agent.core.McTestFixtureProvider;
import io.mctest.agent.core.McTestSession;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;
import org.bukkit.Bukkit;
import org.bukkit.GameMode;
import org.bukkit.GameRule;
import org.bukkit.Material;
import org.bukkit.World;
import org.bukkit.entity.Player;
import org.bukkit.inventory.ItemStack;
import org.bukkit.permissions.PermissionAttachment;
import org.bukkit.plugin.Plugin;
import org.bukkit.plugin.RegisteredServiceProvider;

/**
 * {@code fixture.set} / {@code fixture.reset} — deterministic world/plugin shaping (PROTOCOL.md §7.5,
 * cap {@code fixtures}). Built-in recipes use the Bukkit/Paper API only ({@code gamerule}, {@code time},
 * {@code weather}, {@code inventory}, {@code permissions}); any other fixture is delegated to a
 * registered SUT {@link McTestFixtureProvider} (e.g. {@code regions.createRegion}).
 *
 * <p>Each applied fixture records an {@link AppliedFixture} undo in the session's {@link FixtureLedger}
 * so {@code fixture.reset} reverts a single handle or all of them, and {@code session.close} reverts
 * the remainder (registered once per session as a {@code ResourceRegistry} cleanup).
 */
public final class FixtureManager {

    private static final String LEDGER_ATTR = "fixtureLedger";

    private final Plugin plugin;
    private final AtomicLong handleCounter = new AtomicLong();

    public FixtureManager(Plugin plugin) {
        this.plugin = plugin;
    }

    // --- fixture.set ---

    /**
     * Params {@code { fixture, args? }} →
     * {@code { ok, fixture, applied:true, handle, result? }}. Unknown/failed → {@code -32005};
     * bad args → {@code -32602}.
     */
    public JsonObject set(McTestSession session, JsonObject params) throws McTestException {
        String fixture = Params.requireString(params, "fixture");
        JsonObject argsObj = Params.optObject(params, "args");
        Map<String, Object> args = Params.toArgs(argsObj);
        long timeout = Params.timeoutMs(params, 15000);
        FixtureLedger ledger = ledger(session);

        // Delegate to a SUT provider first when it claims the fixture (regions.* etc.).
        McTestFixtureProvider provider = lookupProvider();
        if (provider != null && provider.supports(fixture)) {
            return applyViaProvider(provider, fixture, args, ledger, timeout);
        }

        // Otherwise a built-in recipe (run on the server thread).
        Applied applied = MainThread.call(plugin,
                () -> applyBuiltIn(fixture, args), timeout);
        String handle = applied.handle;
        ledger.record(new AppliedFixture(handle, fixture,
                () -> MainThread.call(plugin, () -> {
                    applied.undo.run();
                    return null;
                }, timeout)));

        JsonObject result = new JsonObject();
        result.addProperty("ok", true);
        result.addProperty("fixture", fixture);
        result.addProperty("applied", true);
        result.addProperty("handle", handle);
        if (applied.result != null) {
            result.add("result", Params.toJson(applied.result));
        }
        return result;
    }

    private JsonObject applyViaProvider(McTestFixtureProvider provider, String fixture,
                                        Map<String, Object> args, FixtureLedger ledger, long timeout)
            throws McTestException {
        Object providerResult;
        try {
            providerResult = MainThread.call(plugin, () -> provider.apply(fixture, args), timeout);
        } catch (McTestException e) {
            // A provider that threw a plain exception (bad args / failed recipe) was wrapped as
            // -32603 by MainThread; re-classify it as -32005 FIXTURE_FAILED (PROTOCOL.md §7.5/§9.2).
            // A provider that deliberately raised a typed McTestException passes through unchanged.
            if (e.code == Errors.INTERNAL_ERROR) {
                throw McTestException.fixtureFailed("Fixture '" + fixture + "' failed: " + e.getMessage());
            }
            throw e;
        }
        // Use the provider's OWN handle so undo(handle) reverses exactly what apply() created, and so
        // the wire `handle` matches the SUT recipe (PROTOCOL.md §7.5 / the fixture.set conformance
        // fixture: "fx_region_TestRegion"). Fall back to an agent-minted handle only if the provider
        // returned none.
        String handle = providerHandle(providerResult);
        if (handle == null) {
            handle = "fx_" + sanitize(fixture) + "_" + handleCounter.incrementAndGet();
        }
        final String undoHandle = handle;
        ledger.record(new AppliedFixture(handle, fixture,
                () -> MainThread.call(plugin, () -> {
                    provider.undo(undoHandle);
                    return null;
                }, timeout)));

        JsonObject result = new JsonObject();
        result.addProperty("ok", true);
        result.addProperty("fixture", fixture);
        result.addProperty("applied", true);
        result.addProperty("handle", handle);
        if (providerResult != null) {
            result.add("result", Params.toJson(providerResult));
        }
        return result;
    }

    /** The handle a provider returned in its result map ({@code {handle: ...}}), or null. */
    private static String providerHandle(Object providerResult) {
        if (providerResult instanceof Map) {
            Object h = ((Map<?, ?>) providerResult).get("handle");
            if (h != null) {
                return String.valueOf(h);
            }
        }
        return null;
    }

    // --- fixture.reset ---

    /**
     * Params {@code { snapshot?, world?, fixtureId? }} → {@code { ok, restored?, tookMs? }}. With a
     * {@code fixtureId} (handle) reverts that one fixture; otherwise reverts all session fixtures.
     * A {@code snapshot} restore is not supported by this agent build (no snapshot machinery) and is
     * reported as {@code -32005 FIXTURE_FAILED} so the runner can skip honestly rather than false-green.
     */
    public JsonObject reset(McTestSession session, JsonObject params) throws McTestException {
        long start = System.currentTimeMillis();
        FixtureLedger ledger = ledger(session);
        String fixtureId = Params.optString(params, "fixtureId", null);
        String snapshot = Params.optString(params, "snapshot", null);

        if (snapshot != null) {
            throw McTestException.fixtureFailed(
                    "Snapshot restore is not supported by the bukkit agent: " + snapshot);
        }

        JsonObject result = new JsonObject();
        result.addProperty("ok", true);
        if (fixtureId != null) {
            boolean reverted = ledger.revertOne(fixtureId);
            if (!reverted) {
                throw McTestException.fixtureFailed("Unknown or already-reverted fixture: " + fixtureId);
            }
            result.addProperty("restored", fixtureId);
        } else {
            FixtureLedger.RevertResult rr = ledger.revertAll();
            if (!rr.errors.isEmpty()) {
                throw McTestException.fixtureFailed("Some fixtures failed to revert: " + rr.errors);
            }
            result.addProperty("restored", rr.reverted);
        }
        result.addProperty("tookMs", System.currentTimeMillis() - start);
        return result;
    }

    // --- built-in recipes (server thread) ---

    /** A built-in apply outcome: a handle, its undo action, and an optional wire result payload. */
    private static final class Applied {
        final String handle;
        final BuiltInUndo undo;
        final Object result;

        Applied(String handle, BuiltInUndo undo, Object result) {
            this.handle = handle;
            this.undo = undo;
            this.result = result;
        }
    }

    @FunctionalInterface
    private interface BuiltInUndo {
        void run() throws Exception;
    }

    private Applied applyBuiltIn(String fixture, Map<String, Object> args) throws McTestException {
        String handle = "fx_" + sanitize(fixture) + "_" + handleCounter.incrementAndGet();
        switch (fixture) {
            case "gamerule":
                return applyGamerule(handle, args);
            case "time":
                return applyTime(handle, args);
            case "weather":
                return applyWeather(handle, args);
            case "inventory":
                return applyInventory(handle, args);
            case "permissions":
                return applyPermissions(handle, args);
            default:
                throw McTestException.fixtureFailed("Unknown fixture: " + fixture);
        }
    }

    @SuppressWarnings({"unchecked", "rawtypes"})
    private Applied applyGamerule(String handle, Map<String, Object> args) throws McTestException {
        String name = str(args.get("rule"));
        Object value = args.get("value");
        if (name == null || value == null) {
            throw McTestException.invalidParams("gamerule requires { rule, value }");
        }
        World world = resolveWorld(str(args.get("world")));
        if (world == null) {
            throw McTestException.fixtureFailed("World not loaded for gamerule");
        }
        GameRule rule = GameRule.getByName(name);
        if (rule == null) {
            throw McTestException.fixtureFailed("Unknown gamerule: " + name);
        }
        Object previous = world.getGameRuleValue(rule);
        Object coerced = coerceGameRule(rule, value);
        if (!world.setGameRule(rule, coerced)) {
            throw McTestException.fixtureFailed("Failed to set gamerule " + name);
        }
        World w = world;
        GameRule r = rule;
        Object prev = previous;
        return new Applied(handle, () -> w.setGameRule(r, prev), null);
    }

    private Applied applyTime(String handle, Map<String, Object> args) throws McTestException {
        Object value = args.get("time");
        if (!(value instanceof Number)) {
            throw McTestException.invalidParams("time requires numeric { time }");
        }
        World world = resolveWorld(str(args.get("world")));
        if (world == null) {
            throw McTestException.fixtureFailed("World not loaded for time");
        }
        long previous = world.getTime();
        world.setTime(((Number) value).longValue());
        return new Applied(handle, () -> world.setTime(previous), null);
    }

    private Applied applyWeather(String handle, Map<String, Object> args) throws McTestException {
        String state = str(args.get("state"));
        if (state == null) {
            throw McTestException.invalidParams("weather requires { state: clear|rain|thunder }");
        }
        World world = resolveWorld(str(args.get("world")));
        if (world == null) {
            throw McTestException.fixtureFailed("World not loaded for weather");
        }
        boolean prevStorm = world.hasStorm();
        boolean prevThunder = world.isThundering();
        switch (state) {
            case "clear":
                world.setStorm(false);
                world.setThundering(false);
                break;
            case "rain":
                world.setStorm(true);
                world.setThundering(false);
                break;
            case "thunder":
                world.setStorm(true);
                world.setThundering(true);
                break;
            default:
                throw McTestException.fixtureFailed("Unknown weather state: " + state);
        }
        return new Applied(handle, () -> {
            world.setStorm(prevStorm);
            world.setThundering(prevThunder);
        }, null);
    }

    @SuppressWarnings("unchecked")
    private Applied applyInventory(String handle, Map<String, Object> args) throws McTestException {
        String playerName = str(args.get("player"));
        Player player = playerName != null ? Bukkit.getPlayerExact(playerName) : null;
        if (player == null) {
            throw McTestException.fixtureFailed("Player not online for inventory fixture: " + playerName);
        }
        String op = str(args.get("op"));
        if ("clear".equals(op)) {
            ItemStack[] before = player.getInventory().getContents().clone();
            player.getInventory().clear();
            return new Applied(handle, () -> player.getInventory().setContents(before), null);
        }
        // Default op = give.
        String itemId = str(args.get("item"));
        if (itemId == null) {
            throw McTestException.invalidParams("inventory give requires { item }");
        }
        Material material = Material.matchMaterial(itemId);
        if (material == null) {
            throw McTestException.fixtureFailed("Unknown item: " + itemId);
        }
        int count = args.get("count") instanceof Number ? ((Number) args.get("count")).intValue() : 1;
        // Snapshot-and-restore (like the clear op) so the reversal is EXACT regardless of whether the
        // stack fully fit or the player already held matching items — removeItem(stack) would not
        // faithfully restore pristine inventory state in those cases.
        ItemStack[] before = player.getInventory().getContents().clone();
        ItemStack stack = new ItemStack(material, Math.max(1, count));
        player.getInventory().addItem(stack);
        Player p = player;
        return new Applied(handle, () -> p.getInventory().setContents(before), null);
    }

    private Applied applyPermissions(String handle, Map<String, Object> args) throws McTestException {
        String playerName = str(args.get("player"));
        String node = str(args.get("node"));
        if (playerName == null || node == null) {
            throw McTestException.invalidParams("permissions requires { player, node }");
        }
        Player player = Bukkit.getPlayerExact(playerName);
        if (player == null) {
            throw McTestException.fixtureFailed("Player not online for permissions fixture: " + playerName);
        }
        boolean grant = !"revoke".equals(str(args.get("op")));
        PermissionAttachment attachment = player.addAttachment(plugin);
        attachment.setPermission(node, grant);
        return new Applied(handle, attachment::remove, null);
    }

    // --- provider / ledger / helpers ---

    private McTestFixtureProvider lookupProvider() {
        RegisteredServiceProvider<McTestFixtureProvider> rsp =
                Bukkit.getServicesManager().getRegistration(McTestFixtureProvider.class);
        return rsp != null ? rsp.getProvider() : null;
    }

    /** Lazily attaches a {@link FixtureLedger} to the session and registers the close-time revert. */
    private FixtureLedger ledger(McTestSession session) {
        Object existing = session.attrs.get(LEDGER_ATTR);
        if (existing instanceof FixtureLedger) {
            return (FixtureLedger) existing;
        }
        FixtureLedger ledger = new FixtureLedger();
        session.attrs.put(LEDGER_ATTR, ledger);
        // Revert any remaining fixtures when the session closes (PROTOCOL.md §4.4).
        session.resources.register(ledger::revertAll);
        return ledger;
    }

    private World resolveWorld(String worldName) {
        if (worldName != null && !worldName.isEmpty()) {
            return Bukkit.getWorld(worldName);
        }
        return Bukkit.getWorlds().isEmpty() ? null : Bukkit.getWorlds().get(0);
    }

    @SuppressWarnings({"unchecked", "rawtypes"})
    private static Object coerceGameRule(GameRule rule, Object value) {
        Class<?> type = rule.getType();
        if (type == Boolean.class) {
            if (value instanceof Boolean) {
                return value;
            }
            return Boolean.parseBoolean(value.toString());
        }
        if (type == Integer.class) {
            if (value instanceof Number) {
                return ((Number) value).intValue();
            }
            return Integer.parseInt(value.toString());
        }
        return value;
    }

    private static String sanitize(String s) {
        return s.replaceAll("[^A-Za-z0-9]", "_");
    }

    private static String str(Object o) {
        return o != null ? o.toString() : null;
    }

    /** @return GameMode by lowercase name, or null. (Reserved for fixtures that set game mode.) */
    static GameMode gameMode(String name) {
        if (name == null) {
            return null;
        }
        for (GameMode gm : GameMode.values()) {
            if (gm.name().equalsIgnoreCase(name)) {
                return gm;
            }
        }
        return null;
    }

    /** Exposed for diagnostics/tests: the handles currently applied in a session. */
    public List<String> appliedHandles(McTestSession session) {
        Object existing = session.attrs.get(LEDGER_ATTR);
        return existing instanceof FixtureLedger ? ((FixtureLedger) existing).handles() : new ArrayList<>();
    }
}
