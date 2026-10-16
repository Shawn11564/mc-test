package io.mctest.agent.bukkit.players;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import io.mctest.agent.bukkit.MainThread;
import io.mctest.agent.bukkit.Params;
import io.mctest.agent.core.McTestException;
import io.mctest.agent.core.McTestSession;
import io.mctest.agent.core.MenuView;
import io.mctest.agent.core.Menus;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.bukkit.Bukkit;
import org.bukkit.GameMode;
import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.NamespacedKey;
import org.bukkit.World;
import org.bukkit.entity.Entity;
import org.bukkit.entity.Player;
import org.bukkit.event.inventory.InventoryType;
import org.bukkit.inventory.Inventory;
import org.bukkit.inventory.InventoryView;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.meta.ItemMeta;
import org.bukkit.plugin.Plugin;
import org.bukkit.util.Vector;

/**
 * {@code player.spawnFake} / {@code player.despawnFake} / {@code player.act} / {@code player.list} —
 * server-side fake players (PROTOCOL.md §7.5, cap {@code fakePlayers}). Two backends:
 * <ul>
 *   <li><b>native</b> ({@link NativeFakePlayers}, spec/42 Plan C) — a real {@code ServerPlayer} on the
 *       real join path via reflection against Paper's Mojang-mapped runtime (1.20.5+), probe-gated at
 *       enable. Supports the full portable verb set; interaction verbs keep Bukkit-event fidelity.</li>
 *   <li><b>carpet</b> (legacy, opt-in via {@code fakePlayers: true} in config.yml) — dispatches
 *       Carpet's {@code /player} console command; spawn/despawn only, no {@code player.act}.</li>
 * </ul>
 * When the native probe succeeds it is the backend; otherwise Carpet-if-enabled; otherwise the
 * capability is not advertised at all and those steps honestly skip (PD-4).
 *
 * <p><b>Ownership and lifetime (spec/42)</b> mirror the fabric agent exactly: one agent-global roster
 * is the puppetability boundary (a real player is never in it); {@code persist:false} spawns are
 * session-scoped and die on {@code session.close}; {@code persist:true} spawns and every
 * {@code /actor} spawn survive until {@code player.despawnFake}, {@code /actor remove}, or server
 * stop. {@code player.list} exposes the roster with live Bukkit-API state (backend-neutral). All game
 * access bounces to the main thread via {@link MainThread}; the {@code command*} front door is called
 * ON the main thread by the {@code /actor} command.
 */
public final class FakePlayerManager {

    private static final String REGISTRY_ATTR = "fakePlayers";

    /** The portable actor verbs {@code player.act} accepts (native backend only). */
    public static final String[] ACT_VERBS = {
            "teleport", "lookAt", "chat", "command", "attack", "interactEntity", "interactBlock",
            "clickMenuSlot", "clickMenuText", "give", "hold", "sneak", "sprint", "setGameMode",
    };

    /** One agent-owned fake player (either front door, either backend). */
    public static final class ActorRecord {
        public final String name;
        public final String uuid;
        public final boolean persist;
        public final String spawnedBy; // "mctp" | "command"
        public final String backend;   // "native" | "carpet"
        final String sessionId;        // owning session for session-scoped spawns; null when persist

        ActorRecord(String name, String uuid, boolean persist, String spawnedBy, String backend,
                String sessionId) {
            this.name = name;
            this.uuid = uuid;
            this.persist = persist;
            this.spawnedBy = spawnedBy;
            this.backend = backend;
            this.sessionId = sessionId;
        }
    }

    private final Plugin plugin;
    private final NativeFakePlayers nativeBackend; // null when the probe failed
    private final boolean carpetEnabled;

    /** Agent-global roster (name → record); guarded by {@code synchronized (actors)}. */
    private final Map<String, ActorRecord> actors = new LinkedHashMap<>();

    public FakePlayerManager(Plugin plugin, NativeFakePlayers nativeBackend, boolean carpetEnabled) {
        this.plugin = plugin;
        this.nativeBackend = nativeBackend;
        this.carpetEnabled = carpetEnabled;
    }

    /** @return true when the probe-gated native backend is active (act/command surface available). */
    public boolean isNative() {
        return nativeBackend != null;
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

        String handle = "fp_" + name;
        String backend = nativeBackend != null ? "native" : "carpet";
        UUID uuid = MainThread.call(plugin, () -> spawnOnMain(name, at, gameMode), timeout);

        synchronized (actors) {
            actors.put(name, new ActorRecord(name, uuid.toString(), persist, "mctp", backend,
                    persist ? null : session.id));
        }
        if (!persist) {
            registry.spawned.put(handle, name);
            // Despawn-on-close is registered once per session via the registry cleanup.
        }

        JsonObject result = new JsonObject();
        result.addProperty("ok", true);
        result.addProperty("name", name);
        result.addProperty("uuid", uuid.toString());
        result.addProperty("handle", handle);
        return result;
    }

    /**
     * Params {@code { handle?, name? }} → {@code { ok, despawned }}. Persistent actors may be
     * despawned from any session; session-scoped ones only by their spawning session.
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
     * Native-backed actors only — a Carpet bot has no act surface (that is exactly why the native
     * backend exists).
     */
    public JsonObject act(McTestSession session, JsonObject params) throws McTestException {
        String verb = Params.requireString(params, "verb");
        JsonObject rawArgs = Params.optObject(params, "args");
        JsonObject args = rawArgs != null ? rawArgs : new JsonObject();
        long timeout = Params.timeoutMs(params, 15000);
        String playerName = resolveActor(session, params);
        ActorRecord record;
        synchronized (actors) {
            record = actors.get(playerName);
        }
        if (record == null || !"native".equals(record.backend)) {
            throw McTestException.invalidParams(
                    "player.act requires the native backend; '" + playerName + "' is carpet-backed");
        }

        String detail = MainThread.call(plugin, () -> dispatchVerb(playerName, verb, args), timeout);

        JsonObject result = new JsonObject();
        result.addProperty("ok", true);
        result.addProperty("handle", "fp_" + playerName);
        result.addProperty("verb", verb);
        result.addProperty("detail", detail);
        return result;
    }

    /**
     * Params {@code { sessionId }} → the agent-owned roster with live Bukkit-API state (spec/42).
     */
    public JsonObject list(McTestSession session, JsonObject params) throws McTestException {
        long timeout = Params.timeoutMs(params, 15000);
        List<ActorRecord> snapshot = records();

        JsonArray players = MainThread.call(plugin, () -> {
            JsonArray out = new JsonArray();
            for (ActorRecord r : snapshot) {
                JsonObject e = new JsonObject();
                e.addProperty("name", r.name);
                e.addProperty("uuid", r.uuid);
                e.addProperty("persist", r.persist);
                e.addProperty("spawnedBy", r.spawnedBy);
                Player online = Bukkit.getPlayerExact(r.name);
                e.addProperty("online", online != null);
                if (online != null) {
                    Location loc = online.getLocation();
                    JsonObject pos = new JsonObject();
                    pos.addProperty("x", loc.getX());
                    pos.addProperty("y", loc.getY());
                    pos.addProperty("z", loc.getZ());
                    e.add("position", pos);
                    e.addProperty("dimension", online.getWorld().getKey().toString());
                    e.addProperty("gameMode", online.getGameMode().name().toLowerCase(java.util.Locale.ROOT));
                    e.addProperty("health", online.getHealth());
                }
                out.add(e);
            }
            return out;
        }, timeout);

        JsonObject result = new JsonObject();
        result.addProperty("ok", true);
        result.add("players", players);
        return result;
    }


    /**
     * Params {@code { handle?, name?, timeoutMs? }} -> {@code { ok, handle, open, type?, title?,
     * size?, slots? }} — what the actor's open menu holds, so a controller can see a modded GUI's
     * real contents (and their exact slot numbers) instead of guessing at a grid.
     */
    public JsonObject menu(McTestSession session, JsonObject params) throws McTestException {
        long timeout = Params.timeoutMs(params, 15000);
        String playerName = resolveActor(session, params);
        MenuView view = MainThread.call(plugin, () -> menuOf(requireOnline(playerName)), timeout);
        JsonObject result = Menus.json(view);
        result.addProperty("ok", true);
        result.addProperty("handle", "fp_" + playerName);
        result.addProperty("name", playerName);
        return result;
    }

    // --- command front door (/actor; runs ON the main thread — no bounce) ---

    /**
     * Click-by-text, resolved and clicked in one main-thread pass — the ONE implementation behind
     * both front doors ({@code player.act clickMenuText} and {@code /actor <name> click}).
     *
     * <p>Zero matches and (without an explicit {@code index}) more than one are refused, carrying the
     * protocol's own {@code ELEMENT_NOT_FOUND}/{@code AMBIGUOUS_SELECTOR} and, in the message, the
     * text the menu actually shows. Clicking the wrong row of a steal menu is a real action with real
     * consequences; a guess is worse than a question.
     */
    public String clickMenuText(Player player, String text, boolean exact, boolean lore,
            Integer index, int button, String mode) throws McTestException {
        MenuView view = menuOf(player);
        if (!view.open) {
            throw McTestException.invalidParams("clickMenuText: no menu open for " + player.getName());
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
        nativeBackend.clickMenuSlot(player, slot, button, mode);
        return "clicked slot " + slot + " (" + label + ")";
    }

    /** What the actor's open menu holds, one line, for {@code /actor <name> menu}. Main thread only. */
    public String describeMenu(String name) throws McTestException {
        MenuView view = menuOf(requireOnline(name));
        if (!view.open) {
            return "no menu open";
        }
        return (view.type == null ? "menu" : view.type) + " (" + view.size + " slots): "
                + Menus.describe(view);
    }

    /**
     * The open menu, read through the plain Bukkit API — no NMS needed, so this works on every
     * runtime the plugin loads on. A player with nothing open still "has" its 2x2 crafting view;
     * that is precisely what {@code containerMenu == inventoryMenu} means in the native backend, so
     * both front doors agree on what "no menu open" is.
     *
     * <p>Raw slot indices are the ones the click protocol addresses, i.e. the same numbers
     * {@code clickMenuSlot} takes. Bukkit exposes no translated item name server-side, so an item
     * without a custom display name is labelled from its material ({@code ENDER_PEARL} -> "Ender
     * Pearl") — close enough to the client's own wording for a text match to mean the obvious thing.
     */
    private MenuView menuOf(Player player) {
        InventoryView view = player.getOpenInventory();
        Inventory top = view.getTopInventory();
        InventoryType type = top.getType();
        if (type == InventoryType.CRAFTING || type == InventoryType.PLAYER) {
            return MenuView.CLOSED;
        }
        // Raw slots = the container plus the player's 36 main-inventory slots, which is what the
        // click protocol addresses. NOT countSlots(): that adds the bottom inventory's armor and
        // offhand slots (41, not 36), which a container menu does not expose — asking getItem() for
        // one of those overruns the view and was a live IndexOutOfBounds on Paper 1.21.1.
        int slots = Math.min(top.getSize() + 36, view.countSlots());
        List<MenuView.Slot> rows = new ArrayList<>();
        for (int i = 0; i < slots; i++) {
            ItemStack stack = view.getItem(i);
            if (stack == null || stack.getType() == Material.AIR) {
                continue;
            }
            ItemMeta meta = stack.hasItemMeta() ? stack.getItemMeta() : null;
            String name = meta != null && meta.hasDisplayName()
                    ? meta.getDisplayName() : prettyMaterial(stack.getType());
            List<String> lore = meta != null && meta.getLore() != null
                    ? meta.getLore() : java.util.Collections.<String>emptyList();
            rows.add(new MenuView.Slot(i, stack.getType().getKey().toString(), stack.getAmount(),
                    name, lore, i >= top.getSize()));
        }
        return MenuView.of(type.name().toLowerCase(java.util.Locale.ROOT), view.getTitle(), slots, rows);
    }

    /** {@code ENDER_PEARL} -> {@code Ender Pearl}. */
    private static String prettyMaterial(Material material) {
        StringBuilder out = new StringBuilder();
        for (String word : material.name().toLowerCase(java.util.Locale.ROOT).split("_")) {
            if (word.isEmpty()) {
                continue;
            }
            if (out.length() > 0) {
                out.append(' ');
            }
            out.append(Character.toUpperCase(word.charAt(0))).append(word.substring(1));
        }
        return out.toString();
    }

    /** The online Bukkit player for an actor name, or {@code -32602}. */
    private Player requireOnline(String name) throws McTestException {
        Player player = Bukkit.getPlayerExact(name);
        if (player == null) {
            throw McTestException.invalidParams("Fake player not online: " + name);
        }
        return player;
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


    /** Spawns a PERSISTENT native actor at the given location. Main thread only. */
    public String commandSpawn(String name, Location at, String gameMode) throws McTestException {
        if (nativeBackend == null) {
            throw McTestException.invalidParams("Native backend unavailable on this server");
        }
        UUID uuid = nativeBackend.spawn(name, at, at.getWorld());
        applySpawnExtras(name, jsonAt(at), gameMode);
        synchronized (actors) {
            actors.put(name, new ActorRecord(name, uuid.toString(), true, "command", "native", null));
        }
        return uuid.toString();
    }

    /** Despawns one agent-owned actor by name; false if not in the roster. Main thread only. */
    public boolean commandRemove(String name) {
        ActorRecord record;
        synchronized (actors) {
            record = actors.remove(name);
        }
        if (record == null) {
            return false;
        }
        despawnOnMain(record);
        return true;
    }

    /** Despawns every agent-owned actor; returns how many. Main thread only. */
    public int commandRemoveAll() {
        List<ActorRecord> all;
        synchronized (actors) {
            all = new ArrayList<>(actors.values());
            actors.clear();
        }
        for (ActorRecord r : all) {
            despawnOnMain(r);
        }
        return all.size();
    }

    /** The puppetability guard for the command front door. */
    public boolean isActor(String name) {
        synchronized (actors) {
            return actors.containsKey(name);
        }
    }

    /** Snapshot of the agent-owned roster. */
    public List<ActorRecord> records() {
        synchronized (actors) {
            return new ArrayList<>(actors.values());
        }
    }

    /** One act verb for the /actor command (main thread; caller guards with {@link #isActor}). */
    public String commandVerb(String name, String verb, JsonObject args) throws McTestException {
        return dispatchVerb(name, verb, args);
    }

    // --- helpers ---

    /** Spawns via the active backend (main thread). */
    private UUID spawnOnMain(String name, JsonObject at, String gameMode) throws McTestException {
        if (nativeBackend != null) {
            Location loc = locationOf(at);
            UUID uuid = nativeBackend.spawn(name, loc, Bukkit.getWorlds().get(0));
            applySpawnExtras(name, at, gameMode);
            return uuid;
        }
        // Carpet: dispatch the console command (spawn/despawn only; Carpet owns the entity).
        StringBuilder cmd = new StringBuilder("player ").append(name).append(" spawn");
        if (at != null) {
            double x = Params.optDouble(at, "x", Double.NaN);
            double y = Params.optDouble(at, "y", Double.NaN);
            double z = Params.optDouble(at, "z", Double.NaN);
            if (!Double.isNaN(x) && !Double.isNaN(y) && !Double.isNaN(z)) {
                cmd.append(" at ").append(x).append(' ').append(y).append(' ').append(z);
            }
        }
        boolean dispatched = Bukkit.dispatchCommand(Bukkit.getConsoleSender(), cmd.toString());
        if (!dispatched) {
            throw McTestException.internal("Carpet /player command rejected: " + cmd);
        }
        Player spawned = Bukkit.getPlayerExact(name);
        return spawned != null ? spawned.getUniqueId() : offlineUuid(name);
    }

    /** Post-join position/gamemode via the Bukkit API (backend-neutral for the native path). */
    private void applySpawnExtras(String name, JsonObject at, String gameMode) throws McTestException {
        Player player = Bukkit.getPlayerExact(name);
        if (player == null) {
            return;
        }
        Location loc = locationOf(at);
        if (loc != null) {
            player.teleport(loc);
        }
        if (gameMode != null && !gameMode.isEmpty()) {
            player.setGameMode(parseGameMode(gameMode));
        }
    }

    private void despawn(String name, long timeout) throws McTestException {
        ActorRecord record;
        synchronized (actors) {
            record = actors.get(name);
        }
        ActorRecord finalRecord = record;
        MainThread.call(plugin, () -> {
            despawnOnMain(finalRecord != null ? finalRecord
                    : new ActorRecord(name, "", false, "mctp",
                            nativeBackend != null ? "native" : "carpet", null));
            return null;
        }, timeout);
    }

    private void despawnOnMain(ActorRecord record) {
        if ("native".equals(record.backend) && nativeBackend != null) {
            nativeBackend.despawn(record.name);
        } else {
            Bukkit.dispatchCommand(Bukkit.getConsoleSender(), "player " + record.name + " kill");
        }
    }

    /** Runs one verb on the main thread (already bounced/being on it). */
    private String dispatchVerb(String name, String verb, JsonObject args) throws McTestException {
        Player player = Bukkit.getPlayerExact(name);
        if (player == null) {
            throw McTestException.invalidParams("Fake player not online: " + name);
        }
        switch (verb) {
            case "teleport": {
                World world = resolveWorld(Params.optString(args, "world", null), player.getWorld());
                player.teleport(new Location(world, requireDouble(args, "x"),
                        requireDouble(args, "y"), requireDouble(args, "z"),
                        player.getLocation().getYaw(), player.getLocation().getPitch()));
                return "teleported";
            }
            case "lookAt": {
                lookAt(player, requireDouble(args, "x"), requireDouble(args, "y"),
                        requireDouble(args, "z"));
                return "looking";
            }
            case "chat":
                player.chat(Params.requireString(args, "message"));
                return "chatted";
            case "command":
                Bukkit.dispatchCommand(player, Params.requireString(args, "command"));
                return "dispatched";
            case "attack":
                // LivingEntity#attack runs the full vanilla attack (damage calc, events, cooldown).
                player.attack(requireEntity(Params.requireString(args, "target")));
                return "attacked";
            case "interactEntity":
                return nativeBackend.interactEntity(player,
                        requireEntity(Params.requireString(args, "target")));
            case "interactBlock":
                return nativeBackend.interactBlock(player, Params.requireInt(args, "x"),
                        Params.requireInt(args, "y"), Params.requireInt(args, "z"));
            case "clickMenuSlot": {
                int slot = Params.requireInt(args, "slot");
                nativeBackend.clickMenuSlot(player, slot, clickButton(args), clickMode(args));
                return "clicked slot " + slot;
            }
            case "clickMenuText":
                // Address a slot by the text the GUI shows instead of by counting squares
                // (spec/42): the only workable way to drive a PokeSteal/Cobblemon menu.
                return clickMenuText(player, Params.requireString(args, "text"),
                        optBoolean(args, "exact", false), optBoolean(args, "lore", true),
                        optIndex(args), clickButton(args), clickMode(args));
            case "give": {
                Material material = requireMaterial(Params.requireString(args, "item"));
                int count = (int) Params.optDouble(args, "count", 1);
                Map<Integer, ItemStack> leftover =
                        player.getInventory().addItem(new ItemStack(material, Math.max(1, count)));
                for (ItemStack stack : leftover.values()) {
                    player.getWorld().dropItemNaturally(player.getLocation(), stack);
                }
                return "given";
            }
            case "hold": {
                String itemId = Params.optString(args, "item", null);
                player.getInventory().setItemInMainHand(itemId == null || itemId.isEmpty()
                        ? null : new ItemStack(requireMaterial(itemId), 1));
                return "holding";
            }
            case "sneak":
                player.setSneaking(requireBoolean(args, "on"));
                return "sneak set";
            case "sprint":
                player.setSprinting(requireBoolean(args, "on"));
                return "sprint set";
            case "setGameMode":
                player.setGameMode(parseGameMode(Params.requireString(args, "mode")));
                return "gamemode set";
            default:
                throw McTestException.invalidParams("Unknown act verb: " + verb
                        + " (supported: " + String.join(", ", ACT_VERBS) + ")");
        }
    }

    /** The /actor useblock convenience (main thread; native only). */
    public String commandUseBlockFacing(String name) throws McTestException {
        Player player = Bukkit.getPlayerExact(name);
        if (player == null) {
            throw McTestException.invalidParams("Fake player not online: " + name);
        }
        return nativeBackend.useBlockFacing(player);
    }

    /** Pure-Bukkit look-at: yaw/pitch math + in-place rotation teleport (no Paper-only API). */
    private static void lookAt(Player player, double x, double y, double z) {
        Location eye = player.getEyeLocation();
        Vector dir = new Vector(x - eye.getX(), y - eye.getY(), z - eye.getZ());
        if (dir.lengthSquared() < 1.0E-6) {
            return;
        }
        Location loc = player.getLocation().clone();
        loc.setDirection(dir);
        player.teleport(loc);
    }

    private static World resolveWorld(String worldName, World fallback) throws McTestException {
        if (worldName == null || worldName.isEmpty()) {
            return fallback;
        }
        NamespacedKey key = NamespacedKey.fromString(worldName);
        World byKey = key != null ? Bukkit.getWorld(key) : null;
        if (byKey != null) {
            return byKey;
        }
        World byName = Bukkit.getWorld(worldName);
        if (byName != null) {
            return byName;
        }
        throw McTestException.worldNotReady("World not loaded: " + worldName);
    }

    /** Resolves an act target: an entity UUID or an online player's name (mirrors the fabric agent). */
    private static Entity requireEntity(String target) throws McTestException {
        try {
            UUID id = UUID.fromString(target);
            Entity entity = Bukkit.getEntity(id);
            if (entity == null) {
                throw McTestException.invalidParams("No loaded entity with uuid " + target);
            }
            return entity;
        } catch (IllegalArgumentException e) {
            Player player = Bukkit.getPlayerExact(target);
            if (player != null) {
                return player;
            }
            throw McTestException.invalidParams(
                    "Bad entity target '" + target + "': not a uuid, and no online player by that name");
        }
    }

    private static Material requireMaterial(String itemId) throws McTestException {
        Material material = Material.matchMaterial(itemId);
        if (material == null || !material.isItem()) {
            throw McTestException.invalidParams("Unknown item: " + itemId);
        }
        return material;
    }

    private static GameMode parseGameMode(String mode) throws McTestException {
        try {
            return GameMode.valueOf(mode.toUpperCase(java.util.Locale.ROOT));
        } catch (IllegalArgumentException e) {
            throw McTestException.invalidParams("Unknown gameMode: " + mode);
        }
    }

    private static Location locationOf(JsonObject at) {
        if (at == null) {
            return null;
        }
        double x = Params.optDouble(at, "x", Double.NaN);
        double y = Params.optDouble(at, "y", Double.NaN);
        double z = Params.optDouble(at, "z", Double.NaN);
        if (Double.isNaN(x) || Double.isNaN(y) || Double.isNaN(z)) {
            return null;
        }
        return new Location(Bukkit.getWorlds().get(0), x, y, z);
    }

    private static JsonObject jsonAt(Location loc) {
        JsonObject at = new JsonObject();
        at.addProperty("x", loc.getX());
        at.addProperty("y", loc.getY());
        at.addProperty("z", loc.getZ());
        return at;
    }

    /** Resolves handle/name to an actor this session may drive (same semantics as the fabric agent). */
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
        // Despawn any remaining SESSION-SCOPED fakes on session close (PROTOCOL.md §7.5); persistent
        // actors are never in this registry — spec/42's carve-out.
        session.resources.register(() -> {
            for (String name : new ArrayList<>(registry.spawned.values())) {
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

    /** Deterministic offline UUID (mirrors Bukkit's offline-mode scheme). */
    private static UUID offlineUuid(String name) {
        return UUID.nameUUIDFromBytes(("OfflinePlayer:" + name).getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }
}
