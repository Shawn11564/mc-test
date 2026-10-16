package io.mctest.agent.serverforge.players;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import io.mctest.agent.core.McTestException;
import io.mctest.agent.core.McTestSession;
import io.mctest.agent.core.MenuView;
import io.mctest.agent.core.Menus;
import io.mctest.agent.serverforge.Params;
import io.mctest.agent.serverforge.mappings.Names;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * {@code player.spawnFake} / {@code player.despawnFake} / {@code player.act} / {@code player.list} —
 * server-side fake players (PROTOCOL.md §7.5, cap {@code fakePlayers}). Backend is <b>native</b>
 * (spec/41 tier 2): the fake is a real {@code ServerPlayerEntity} joined through the real join path
 * behind a discard connection, owned by {@link Names#spawnFakePlayer}. No Carpet mod is required;
 * every join/leave/interact hook fires exactly as for a human player, and action verbs run the same
 * event-then-vanilla sequence the packet handler runs.
 *
 * <p>{@code player.act} drives one verb from the portable actor set — {@code teleport}, {@code lookAt},
 * {@code chat}, {@code command}, {@code attack}, {@code interactEntity}, {@code interactBlock},
 * {@code clickMenuSlot}, {@code clickMenuText}, {@code give}, {@code hold}, {@code sneak},
 * {@code sprint}, {@code setGameMode} — and {@code player.menu} reads back the menu a fake player
 * has open, which is what makes clicking a modded GUI by the text it shows possible at all.
 *
 * <p><b>Ownership and lifetime (spec/42).</b> Every fake this agent spawns — through MCTP or the
 * in-game {@code /actor} command — lives in one agent-global roster ({@link #actors}). That roster IS
 * the safety boundary: a name absent from it can never be puppeted, so a real player is untouchable
 * by construction. Lifetime splits on the {@code persist} flag:
 * <ul>
 *   <li>{@code persist:false} (default; what the test runner uses) — session-scoped exactly as
 *       before: only the spawning session may act on it, and {@code session.close}/socket drop
 *       despawns it (PROTOCOL.md §7.5).</li>
 *   <li>{@code persist:true} (bench actors) and every {@code /actor} spawn — agent-global: it
 *       survives session close and socket drops, is addressable by name from ANY session, and dies
 *       only on {@code player.despawnFake}, {@code /actor remove}, or server stop.</li>
 * </ul>
 * {@code player.list} exposes the whole roster (never a real player) so a fresh controller can
 * re-acquire persistent actors after a reconnect. All game access bounces to the server thread via
 * {@link Names#call}; the {@code command*} front door is called ON the server thread by the
 * {@code /actor} command and therefore uses the primitives directly.
 */
public final class FakePlayerManager {

    private static final String REGISTRY_ATTR = "fakePlayers";

    /** The portable actor verbs {@code player.act} accepts (spec/41 §5, minus join/leave = spawn/despawn). */
    public static final String[] ACT_VERBS = {
            "teleport", "lookAt", "chat", "command", "attack", "interactEntity", "interactBlock",
            "clickMenuSlot", "clickMenuText", "give", "hold", "sneak", "sprint", "setGameMode",
    };

    /** One agent-owned fake player (either front door). Immutable identity + ownership. */
    public static final class ActorRecord {
        public final String name;
        public final String uuid;
        /** true = survives session close (agent-global lifetime, spec/42). */
        public final boolean persist;
        /** "mctp" | "command" — which front door spawned it (surfaced by player.list). */
        public final String spawnedBy;
        /** Owning session id for session-scoped spawns; null for persistent actors. */
        final String sessionId;

        ActorRecord(String name, String uuid, boolean persist, String spawnedBy, String sessionId) {
            this.name = name;
            this.uuid = uuid;
            this.persist = persist;
            this.spawnedBy = spawnedBy;
            this.sessionId = sessionId;
        }
    }

    private final Names names;

    /**
     * The agent-global roster: name → record for every fake this agent spawned and has not yet
     * despawned. Guarded by {@code synchronized (actors)} — MCTP runs on WebSocket worker threads
     * while {@code /actor} runs on the server thread.
     */
    private final Map<String, ActorRecord> actors = new LinkedHashMap<>();

    public FakePlayerManager(Names names) {
        this.names = names;
    }

    /** The mappings facade, for the {@code /actor} front door (its handlers run on the server thread). */
    public Names names() {
        return names;
    }

    /**
     * Params {@code { name, at?, gameMode?, persist? }} → {@code { ok, name, uuid, handle }}.
     */
    public JsonObject spawnFake(McTestSession session, JsonObject params) throws McTestException {
        String name = Params.requireString(params, "name");
        JsonObject at = Params.optObject(params, "at");
        String gameMode = Params.optString(params, "gameMode", null);
        boolean persist = optBoolean(params, "persist", false);
        long timeout = Params.timeoutMs(params, 15000);
        Registry registry = registry(session);

        Double x = null;
        Double y = null;
        Double z = null;
        if (at != null) {
            double ax = Params.optDouble(at, "x", Double.NaN);
            double ay = Params.optDouble(at, "y", Double.NaN);
            double az = Params.optDouble(at, "z", Double.NaN);
            if (!Double.isNaN(ax) && !Double.isNaN(ay) && !Double.isNaN(az)) {
                x = ax;
                y = ay;
                z = az;
            }
        }

        String handle = "fp_" + name;
        Double fx = x;
        Double fy = y;
        Double fz = z;
        String uuid = names.call(() -> names.spawnFakePlayer(name, fx, fy, fz, gameMode), timeout);

        synchronized (actors) {
            actors.put(name, new ActorRecord(name, uuid, persist, "mctp",
                    persist ? null : session.id));
        }
        if (!persist) {
            registry.spawned.put(handle, name);
            // Despawn-on-close is registered once per session via the registry cleanup.
        }

        JsonObject result = new JsonObject();
        result.addProperty("ok", true);
        result.addProperty("name", name);
        result.addProperty("uuid", uuid);
        result.addProperty("handle", handle);
        return result;
    }

    /**
     * Params {@code { handle?, name? }} → {@code { ok, despawned }}. Unknown handle/name →
     * {@code -32602 invalidParams}. Persistent actors may be despawned from any session.
     */
    public JsonObject despawnFake(McTestSession session, JsonObject params) throws McTestException {
        long timeout = Params.timeoutMs(params, 15000);
        String resolvedName = resolveActor(session, params);
        String handle = "fp_" + resolvedName;

        despawn(resolvedName, timeout);
        synchronized (actors) {
            actors.remove(resolvedName);
        }
        registry(session).spawned.remove(handle);

        JsonObject result = new JsonObject();
        result.addProperty("ok", true);
        result.addProperty("despawned", handle);
        return result;
    }

    /**
     * Params {@code { handle?, name?, verb, args?, timeoutMs? }} → {@code { ok, handle, verb, detail }}.
     * Drives one portable actor verb on an agent-owned fake — this session's spawns, or any
     * persistent actor; anything else is {@code -32602 invalidParams} (unknown handle, unknown verb,
     * missing verb args). Real players never resolve: they are not in the roster.
     */
    public JsonObject act(McTestSession session, JsonObject params) throws McTestException {
        String verb = Params.requireString(params, "verb");
        JsonObject rawArgs = Params.optObject(params, "args");
        JsonObject args = rawArgs != null ? rawArgs : new JsonObject();
        long timeout = Params.timeoutMs(params, 15000);
        String playerName = resolveActor(session, params);
        String handle = "fp_" + playerName;

        String detail = names.call(() -> dispatchVerb(playerName, verb, args), timeout);

        JsonObject result = new JsonObject();
        result.addProperty("ok", true);
        result.addProperty("handle", handle);
        result.addProperty("verb", verb);
        result.addProperty("detail", detail);
        return result;
    }

    /**
     * Params {@code { sessionId }} → {@code { ok, players: [{ name, uuid, persist, spawnedBy,
     * online, position?, dimension?, gameMode?, health? }] }} — the full agent-owned roster
     * (spec/42), so a fresh controller can re-acquire persistent actors after a reconnect.
     */
    public JsonObject list(McTestSession session, JsonObject params) throws McTestException {
        long timeout = Params.timeoutMs(params, 15000);
        List<ActorRecord> snapshot = records();
        List<String> namesOnly = new ArrayList<>(snapshot.size());
        for (ActorRecord r : snapshot) {
            namesOnly.add(r.name);
        }
        // One server-thread bounce for the whole roster, not one per actor.
        List<Names.ActorState> states = names.call(() -> {
            List<Names.ActorState> out = new ArrayList<>(namesOnly.size());
            for (String n : namesOnly) {
                out.add(names.fakePlayerState(n));
            }
            return out;
        }, timeout);

        JsonArray players = new JsonArray();
        for (int i = 0; i < snapshot.size(); i++) {
            ActorRecord r = snapshot.get(i);
            Names.ActorState st = states.get(i);
            JsonObject e = new JsonObject();
            e.addProperty("name", r.name);
            e.addProperty("uuid", r.uuid);
            e.addProperty("persist", r.persist);
            e.addProperty("spawnedBy", r.spawnedBy);
            e.addProperty("online", st.online);
            if (st.online) {
                JsonObject pos = new JsonObject();
                pos.addProperty("x", st.x);
                pos.addProperty("y", st.y);
                pos.addProperty("z", st.z);
                e.add("position", pos);
                e.addProperty("dimension", st.dimension);
                e.addProperty("gameMode", st.gameMode);
                e.addProperty("health", st.health);
            }
            players.add(e);
        }

        JsonObject result = new JsonObject();
        result.addProperty("ok", true);
        result.add("players", players);
        return result;
    }


    /**
     * Params {@code { handle?, name?, timeoutMs? }} → {@code { ok, handle, open, type?, title?,
     * size?, slots? }} — what the actor's open menu holds, so a controller can see a modded GUI's
     * real contents (and their exact slot numbers) instead of guessing at a grid. The player's own
     * inventory screen is not a menu: {@code open:false} there, exactly as {@code clickMenuSlot}
     * refuses it.
     */
    public JsonObject menu(McTestSession session, JsonObject params) throws McTestException {
        long timeout = Params.timeoutMs(params, 15000);
        String playerName = resolveActor(session, params);
        MenuView view = names.call(() -> names.menuOf(playerName), timeout);
        JsonObject result = Menus.json(view);
        result.addProperty("ok", true);
        result.addProperty("handle", "fp_" + playerName);
        result.addProperty("name", playerName);
        return result;
    }

    // --- command front door (/actor; runs ON the server thread — no bounce) ---

    /**
     * Click-by-text, resolved and clicked in one server-thread pass — the ONE implementation behind
     * both front doors ({@code player.act clickMenuText} and {@code /actor <name> click}).
     *
     * <p>Zero matches and (without an explicit {@code index}) more than one are refused, carrying the
     * protocol's own {@code ELEMENT_NOT_FOUND}/{@code AMBIGUOUS_SELECTOR} and, in the message, the
     * text the menu actually shows. Clicking the wrong row of a steal menu is a real action with real
     * consequences; a guess is worse than a question.
     */
    public String clickMenuText(String player, String text, boolean exact, boolean lore,
            Integer index, int button, String mode) throws McTestException {
        MenuView view = names.menuOf(player);
        if (!view.open) {
            throw McTestException.invalidParams("clickMenuText: no menu open for " + player);
        }
        List<Integer> hits = Menus.find(view, text, exact, lore);
        if (hits.isEmpty()) {
            throw Menus.notFound(text, view);
        }
        if (index == null && hits.size() > 1) {
            throw Menus.ambiguous(text, hits, view);
        }
        int nth = index == null ? 0 : index;
        if (nth < 0 || nth >= hits.size()) {
            throw McTestException.invalidParams("clickMenuText: \"" + text + "\" matched "
                    + hits.size() + " slot(s) — no index " + nth);
        }
        int slot = hits.get(nth);
        String label = Menus.label(Menus.slot(view, slot));
        names.actClickMenuSlot(player, slot, button, mode);
        return "clicked slot " + slot + " (" + label + ")";
    }

    /** What the actor's open menu holds, one line, for {@code /actor <name> menu}. Server thread only. */
    public String describeMenu(String player) throws McTestException {
        MenuView view = names.menuOf(player);
        if (!view.open) {
            return "no menu open";
        }
        return (view.type == null ? "menu" : view.type) + " (" + view.size + " slots): "
                + Menus.describe(view);
    }


    /**
     * Spawns a PERSISTENT actor at the given position (the caller's, for {@code /actor spawn}),
     * teleporting into {@code worldId} when it isn't the overworld. Server thread only.
     */
    public String commandSpawn(String name, double x, double y, double z, String worldId,
            String gameMode) throws McTestException {
        String uuid = names.spawnFakePlayer(name, x, y, z, gameMode);
        if (worldId != null) {
            names.actTeleport(name, worldId, x, y, z);
        }
        synchronized (actors) {
            actors.put(name, new ActorRecord(name, uuid, true, "command", null));
        }
        return uuid;
    }

    /** Despawns one agent-owned actor by name; false if the name is not in the roster. Server thread only. */
    public boolean commandRemove(String name) {
        synchronized (actors) {
            if (!actors.containsKey(name)) {
                return false;
            }
            actors.remove(name);
        }
        names.despawnFakePlayer(name);
        return true;
    }

    /** Despawns every agent-owned actor; returns how many. Server thread only. */
    public int commandRemoveAll() {
        List<String> all;
        synchronized (actors) {
            all = new ArrayList<>(actors.keySet());
            actors.clear();
        }
        for (String n : all) {
            names.despawnFakePlayer(n);
        }
        return all.size();
    }

    /** The puppetability guard for the command front door: only roster names may be driven. */
    public boolean isActor(String name) {
        synchronized (actors) {
            return actors.containsKey(name);
        }
    }

    /** Snapshot of the agent-owned roster (for {@code /actor list} and diagnostics). */
    public List<ActorRecord> records() {
        synchronized (actors) {
            return new ArrayList<>(actors.values());
        }
    }

    // --- helpers ---

    /** Runs one verb on the server thread (already bounced by the caller). */
    private String dispatchVerb(String player, String verb, JsonObject args) throws McTestException {
        switch (verb) {
            case "teleport":
                names.actTeleport(player, Params.optString(args, "world", null),
                        requireDouble(args, "x"), requireDouble(args, "y"), requireDouble(args, "z"));
                return "teleported";
            case "lookAt":
                names.actLookAt(player, requireDouble(args, "x"), requireDouble(args, "y"),
                        requireDouble(args, "z"));
                return "looking";
            case "chat":
                names.actChat(player, Params.requireString(args, "message"));
                return "chatted";
            case "command":
                names.actCommand(player, Params.requireString(args, "command"));
                return "dispatched";
            case "attack":
                return names.actAttackEntity(player, Params.requireString(args, "target"));
            case "interactEntity":
                return names.actInteractEntity(player, Params.requireString(args, "target"));
            case "interactBlock":
                return names.actInteractBlock(player, Params.requireInt(args, "x"),
                        Params.requireInt(args, "y"), Params.requireInt(args, "z"));
            case "clickMenuSlot": {
                int slot = Params.requireInt(args, "slot");
                names.actClickMenuSlot(player, slot, clickButton(args), clickMode(args));
                return "clicked slot " + slot;
            }
            case "clickMenuText":
                // Address a slot by the text the GUI shows instead of by counting squares
                // (spec/42): the only workable way to drive a PokeSteal/Cobblemon menu.
                return clickMenuText(player, Params.requireString(args, "text"),
                        optBoolean(args, "exact", false), optBoolean(args, "lore", true),
                        optIndex(args), clickButton(args), clickMode(args));
            case "give":
                names.actGive(player, Params.requireString(args, "item"),
                        (int) Params.optDouble(args, "count", 1));
                return "given";
            case "hold":
                names.actHold(player, Params.optString(args, "item", null));
                return "holding";
            case "sneak":
                names.actSneak(player, requireBoolean(args, "on"));
                return "sneak set";
            case "sprint":
                names.actSprint(player, requireBoolean(args, "on"));
                return "sprint set";
            case "setGameMode":
                names.actSetGameMode(player, Params.requireString(args, "mode"));
                return "gamemode set";
            default:
                throw McTestException.invalidParams("Unknown act verb: " + verb
                        + " (supported: " + String.join(", ", ACT_VERBS) + ")");
        }
    }

    /**
     * Resolves {@code handle}/{@code name} params to an agent-owned actor this session may drive:
     * the roster is the safety boundary (a real player is never in it), and a session-scoped spawn
     * belongs to its spawning session only. Everything else raises the same
     * "Unknown fake-player handle" {@code invalidParams} as before — a cross-session probe learns
     * nothing.
     */
    private String resolveActor(McTestSession session, JsonObject params) throws McTestException {
        String handle = Params.optString(params, "handle", null);
        String name = Params.optString(params, "name", null);
        if (name == null && handle != null) {
            if (!handle.startsWith("fp_")) {
                throw McTestException.invalidParams("Unknown fake-player handle: " + handle);
            }
            name = handle.substring(3);
        }
        if (name == null) {
            throw McTestException.invalidParams("Requires handle or name");
        }
        ActorRecord record;
        synchronized (actors) {
            record = actors.get(name);
        }
        if (record == null || (!record.persist && !session.id.equals(record.sessionId))) {
            throw McTestException.invalidParams("Unknown fake-player handle: fp_" + name);
        }
        return name;
    }

    /**
     * Mouse button of a menu click: 0 = left, 1 = right (the vanilla click protocol's own field).
     * {@code mode:"right"} is not a click type at all but is what a caller reaches for, so it also
     * lands here — an explicit {@code button} still wins.
     */
    private static int clickButton(JsonObject args) {
        return (int) Params.optDouble(args, "button",
                Menus.button(Params.optString(args, "mode", null), 0));
    }

    /** Canonical click type of a menu click; unknown names raise {@code -32602}. */
    private static String clickMode(JsonObject args) throws McTestException {
        return Menus.clickMode(Params.optString(args, "mode", null));
    }

    /** Explicit match ordinal, or null when the caller did not disambiguate. */
    private static Integer optIndex(JsonObject p) {
        if (p != null && p.has("index") && p.get("index").isJsonPrimitive()
                && p.getAsJsonPrimitive("index").isNumber()) {
            return p.get("index").getAsInt();
        }
        return null;
    }

    private static boolean optBoolean(JsonObject p, String key, boolean def) {
        if (p != null && p.has(key) && p.get(key).isJsonPrimitive()
                && p.getAsJsonPrimitive(key).isBoolean()) {
            return p.get(key).getAsBoolean();
        }
        return def;
    }

    private static double requireDouble(JsonObject args, String key) throws McTestException {
        double value = Params.optDouble(args, key, Double.NaN);
        if (Double.isNaN(value)) {
            throw McTestException.invalidParams("Missing number param: " + key);
        }
        return value;
    }

    private static boolean requireBoolean(JsonObject args, String key) throws McTestException {
        JsonElement el = args.get(key);
        if (el == null || !el.isJsonPrimitive()) {
            throw McTestException.invalidParams("Missing boolean param: " + key);
        }
        try {
            return el.getAsBoolean();
        } catch (RuntimeException e) {
            throw McTestException.invalidParams("Bad boolean param: " + key);
        }
    }

    private void despawn(String name, long timeout) throws McTestException {
        names.call(() -> {
            names.despawnFakePlayer(name);
            return null;
        }, timeout);
    }

    /** Per-session registry of session-scoped spawns ({@code handle → name}); cleaned up on close. */
    private static final class Registry {
        final Map<String, String> spawned = new LinkedHashMap<>();
    }

    private Registry registry(McTestSession session) {
        Object existing = session.attrs.get(REGISTRY_ATTR);
        if (existing instanceof Registry) {
            return (Registry) existing;
        }
        Registry registry = new Registry();
        session.attrs.put(REGISTRY_ATTR, registry);
        // Despawn any remaining SESSION-SCOPED fakes on session close (PROTOCOL.md §7.5). Persistent
        // actors are never in this registry — spec/42's carve-out — so they survive untouched.
        session.resources.register(() -> {
            for (String name : new java.util.ArrayList<>(registry.spawned.values())) {
                synchronized (actors) {
                    actors.remove(name);
                }
                try {
                    despawn(name, 5000);
                } catch (McTestException ignored) {
                    // Best-effort teardown.
                }
            }
            registry.spawned.clear();
        });
        return registry;
    }

    /** Deterministic offline UUID (the identity scheme native spawns use; kept for parity/tools). */
    public static UUID offlineUuid(String name) {
        return UUID.nameUUIDFromBytes(("OfflinePlayer:" + name).getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }
}
