package io.mctest.agent.bukkit.players;

import com.google.gson.JsonObject;
import io.mctest.agent.bukkit.MainThread;
import io.mctest.agent.bukkit.Params;
import io.mctest.agent.core.McTestException;
import io.mctest.agent.core.McTestSession;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import org.bukkit.Bukkit;
import org.bukkit.entity.Player;
import org.bukkit.plugin.Plugin;

/**
 * {@code player.spawnFake} / {@code player.despawnFake} — server-side fake players (PROTOCOL.md §7.5,
 * cap {@code fakePlayers}). Backend is <b>Carpet</b>: a fake is spawned/despawned by dispatching the
 * Carpet console command {@code /player <name> spawn at <x> <y> <z>} (and {@code /player <name> kill})
 * via {@link Bukkit#dispatchCommand}. No NMS — the Carpet mod owns the entity.
 *
 * <p>Spawned fakes are tracked per session (in {@code session.attrs}); a {@code session.close} cleanup
 * despawns any that remain.
 */
public final class FakePlayerManager {

    private static final String REGISTRY_ATTR = "fakePlayers";

    private final Plugin plugin;

    public FakePlayerManager(Plugin plugin) {
        this.plugin = plugin;
    }

    /**
     * Params {@code { name, at?, gameMode? }} → {@code { ok, name, uuid, handle }}.
     */
    public JsonObject spawnFake(McTestSession session, JsonObject params) throws McTestException {
        String name = Params.requireString(params, "name");
        JsonObject at = Params.optObject(params, "at");
        long timeout = Params.timeoutMs(params, 15000);
        Registry registry = registry(session);

        String handle = "fp_" + name;
        UUID uuid = MainThread.call(plugin, () -> {
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
            // The Carpet mod joins the fake on the next tick; resolve its UUID best-effort.
            Player spawned = Bukkit.getPlayerExact(name);
            return spawned != null ? spawned.getUniqueId() : offlineUuid(name);
        }, timeout);

        registry.spawned.put(handle, name);
        // Despawn-on-close is registered once per session via the registry cleanup.

        JsonObject result = new JsonObject();
        result.addProperty("ok", true);
        result.addProperty("name", name);
        result.addProperty("uuid", uuid.toString());
        result.addProperty("handle", handle);
        return result;
    }

    /**
     * Params {@code { handle?, name? }} → {@code { ok, despawned }}. Unknown handle/name →
     * {@code -32602 invalidParams}.
     */
    public JsonObject despawnFake(McTestSession session, JsonObject params) throws McTestException {
        String handle = Params.optString(params, "handle", null);
        String name = Params.optString(params, "name", null);
        long timeout = Params.timeoutMs(params, 15000);
        Registry registry = registry(session);

        if (handle == null && name != null) {
            handle = "fp_" + name;
        }
        if (handle == null) {
            throw McTestException.invalidParams("despawnFake requires handle or name");
        }
        String resolvedName = registry.spawned.get(handle);
        if (resolvedName == null) {
            throw McTestException.invalidParams("Unknown fake-player handle: " + handle);
        }

        despawn(resolvedName, timeout);
        registry.spawned.remove(handle);

        JsonObject result = new JsonObject();
        result.addProperty("ok", true);
        result.addProperty("despawned", handle);
        return result;
    }

    // --- helpers ---

    private void despawn(String name, long timeout) throws McTestException {
        MainThread.call(plugin, () -> {
            Bukkit.dispatchCommand(Bukkit.getConsoleSender(), "player " + name + " kill");
            return null;
        }, timeout);
    }

    /** Per-session fake-player registry holding {@code handle → name}; cleaned up on close. */
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
        // Despawn any remaining fakes on session close (PROTOCOL.md §7.5: agent tracks + despawns).
        session.resources.register(() -> {
            for (String name : new java.util.ArrayList<>(registry.spawned.values())) {
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

    /** Deterministic offline UUID fallback (mirrors Bukkit's offline-mode scheme) when the fake hasn't joined yet. */
    private static UUID offlineUuid(String name) {
        return UUID.nameUUIDFromBytes(("OfflinePlayer:" + name).getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }
}
