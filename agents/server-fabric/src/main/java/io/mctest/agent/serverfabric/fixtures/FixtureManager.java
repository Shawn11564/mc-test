package io.mctest.agent.serverfabric.fixtures;

import com.google.gson.JsonObject;
import io.mctest.agent.core.Errors;
import io.mctest.agent.core.McTestException;
import io.mctest.agent.core.McTestFixtureProvider;
import io.mctest.agent.core.McTestSession;
import io.mctest.agent.serverfabric.Params;
import io.mctest.agent.serverfabric.mappings.Names;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;

/**
 * {@code fixture.set} / {@code fixture.reset} — deterministic world/mod shaping (PROTOCOL.md §7.5,
 * cap {@code fixtures}). Same handler skeleton as the {@code server-bukkit} agent: built-in recipes
 * ({@code gamerule}, {@code time}, {@code weather}, {@code inventory}) plus delegation of any other
 * fixture to a registered SUT {@link McTestFixtureProvider} (e.g. {@code regions.createRegion}).
 *
 * <p>Every game access routes through {@link Names} (the only Yarn-mapped file) on the server thread;
 * the SUT provider is discovered via {@link Names#lookupFixtureProvider()} (a
 * {@link java.util.ServiceLoader} lookup — the Fabric discovery mechanism). Each applied fixture records
 * an {@link AppliedFixture} undo in the session's {@link FixtureLedger} so {@code fixture.reset} reverts
 * a single handle or all of them, and {@code session.close} reverts the remainder.
 *
 * <p>Vanilla Fabric has no Bukkit-style per-player permission API, so the {@code permissions} built-in
 * recipe is unsupported here (it is delegated to the SUT provider when one claims it, otherwise
 * {@code -32005 FIXTURE_FAILED}) — honest, not a false green.
 */
public final class FixtureManager {

    private static final String LEDGER_ATTR = "fixtureLedger";

    private final Names names;
    private final AtomicLong handleCounter = new AtomicLong();

    public FixtureManager(Names names) {
        this.names = names;
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
        McTestFixtureProvider provider = names.lookupFixtureProvider();
        if (provider != null && provider.supports(fixture)) {
            return applyViaProvider(provider, fixture, args, ledger, timeout);
        }

        // Otherwise a built-in recipe (run on the server thread).
        Applied applied = names.call(() -> applyBuiltIn(fixture, args), timeout);
        String handle = applied.handle;
        ledger.record(new AppliedFixture(handle, fixture,
                () -> names.call(() -> {
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
            providerResult = names.call(() -> provider.apply(fixture, args), timeout);
        } catch (McTestException e) {
            // A provider that threw a plain exception (bad args / failed recipe) was wrapped as
            // -32603 by the server-thread bounce; re-classify it as -32005 FIXTURE_FAILED
            // (PROTOCOL.md §7.5/§9.2). A provider that deliberately raised a typed McTestException
            // passes through unchanged.
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
                () -> names.call(() -> {
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
                    "Snapshot restore is not supported by the fabric agent: " + snapshot);
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

    // --- built-in recipes (server thread; all game access via Names) ---

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
                // No vanilla Fabric per-player permission API; honest failure unless a SUT provider
                // claimed it (handled before we reach the built-in path).
                throw McTestException.fixtureFailed(
                        "permissions fixture is not supported by the fabric agent (no provider registered)");
            default:
                throw McTestException.fixtureFailed("Unknown fixture: " + fixture);
        }
    }

    private Applied applyGamerule(String handle, Map<String, Object> args) throws McTestException {
        String name = str(args.get("rule"));
        Object value = args.get("value");
        if (name == null || value == null) {
            throw McTestException.invalidParams("gamerule requires { rule, value }");
        }
        String worldName = str(args.get("world"));
        String previous = names.getGameRule(worldName, name);
        names.setGameRule(worldName, name, value);
        return new Applied(handle, () -> names.setGameRule(worldName, name, previous), null);
    }

    private Applied applyTime(String handle, Map<String, Object> args) throws McTestException {
        Object value = args.get("time");
        if (!(value instanceof Number)) {
            throw McTestException.invalidParams("time requires numeric { time }");
        }
        String worldName = str(args.get("world"));
        long previous = names.getTime(worldName);
        names.setTime(worldName, ((Number) value).longValue());
        return new Applied(handle, () -> names.setTime(worldName, previous), null);
    }

    private Applied applyWeather(String handle, Map<String, Object> args) throws McTestException {
        String state = str(args.get("state"));
        if (state == null) {
            throw McTestException.invalidParams("weather requires { state: clear|rain|thunder }");
        }
        String worldName = str(args.get("world"));
        boolean[] prev = names.getWeather(worldName);
        switch (state) {
            case "clear":
                names.setWeather(worldName, false, false);
                break;
            case "rain":
                names.setWeather(worldName, true, false);
                break;
            case "thunder":
                names.setWeather(worldName, true, true);
                break;
            default:
                throw McTestException.fixtureFailed("Unknown weather state: " + state);
        }
        return new Applied(handle, () -> names.setWeather(worldName, prev[0], prev[1]), null);
    }

    private Applied applyInventory(String handle, Map<String, Object> args) throws McTestException {
        String playerName = str(args.get("player"));
        if (playerName == null) {
            throw McTestException.invalidParams("inventory requires { player }");
        }
        String op = str(args.get("op"));
        if ("clear".equals(op)) {
            Object snapshot = names.clearInventory(playerName);
            if (snapshot == null) {
                throw McTestException.fixtureFailed(
                        "Player not online for inventory fixture: " + playerName);
            }
            return new Applied(handle, () -> names.restoreInventory(snapshot), null);
        }
        // Default op = give.
        String itemId = str(args.get("item"));
        if (itemId == null) {
            throw McTestException.invalidParams("inventory give requires { item }");
        }
        int count = args.get("count") instanceof Number ? ((Number) args.get("count")).intValue() : 1;
        // Snapshot-and-restore so the reversal is EXACT regardless of whether the stack fully fit or the
        // player already held matching items (mirrors the Bukkit agent).
        Object snapshot = names.giveItem(playerName, itemId, count);
        if (snapshot == null) {
            throw McTestException.fixtureFailed("Player not online for inventory fixture: " + playerName);
        }
        return new Applied(handle, () -> names.restoreInventory(snapshot), null);
    }

    // --- ledger / helpers ---

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

    private static String sanitize(String s) {
        return s.replaceAll("[^A-Za-z0-9]", "_");
    }

    private static String str(Object o) {
        return o != null ? o.toString() : null;
    }

    /** Exposed for diagnostics/tests: the handles currently applied in a session. */
    public List<String> appliedHandles(McTestSession session) {
        Object existing = session.attrs.get(LEDGER_ATTR);
        return existing instanceof FixtureLedger ? ((FixtureLedger) existing).handles() : new ArrayList<>();
    }
}
