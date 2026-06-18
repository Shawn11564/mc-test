package io.mctest.agent.bukkit.truth;

import com.google.gson.JsonObject;
import io.mctest.agent.bukkit.MainThread;
import io.mctest.agent.bukkit.Params;
import io.mctest.agent.core.BuiltInStateQueries;
import io.mctest.agent.core.McTestException;
import io.mctest.agent.core.McTestSession;
import io.mctest.agent.core.McTestStateProvider;
import io.mctest.agent.core.Predicates;
import java.util.Map;
import org.bukkit.Bukkit;
import org.bukkit.OfflinePlayer;
import org.bukkit.permissions.Permissible;
import org.bukkit.plugin.Plugin;
import org.bukkit.plugin.RegisteredServiceProvider;

/**
 * {@code truth.assertPluginState} — reads authoritative plugin/mod state for assertions (PROTOCOL.md
 * §7.5, cap {@code pluginState}). The agent fetches/evaluates only; the runner owns the verdict.
 *
 * <p>Resolution order:
 * <ol>
 *   <li><b>Preferred:</b> the SUT's {@link McTestStateProvider}, resolved via the Bukkit
 *       {@code ServicesManager} (the SUT and agent share the same class via the published core).</li>
 *   <li><b>Fallback grammar</b> (when no provider is registered) for a few trivially-available probes:
 *       {@code config.get(<plugin>, <path>)}, {@code perms.has(<player>, <node>)}. Anything else →
 *       {@code -32006 ASSERT_FAILED}.</li>
 * </ol>
 * Unknown query or an evaluation failure → {@code -32006 ASSERT_FAILED}.
 */
public final class PluginStateProbe {

    private final Plugin plugin;

    public PluginStateProbe(Plugin plugin) {
        this.plugin = plugin;
    }

    /**
     * Params {@code { plugin?, query, args?, expect? }} →
     * {@code { ok, query, value, matched, valueJson }}.
     */
    public JsonObject assertPluginState(McTestSession session, JsonObject params) throws McTestException {
        String query = Params.requireString(params, "query");
        JsonObject argsObj = Params.optObject(params, "args");
        Map<String, Object> args = Params.toArgs(argsObj);
        JsonObject expect = Params.optObject(params, "expect");
        long timeout = Params.timeoutMs(params, 15000);

        // Provider probes touch plugin state; run on the server thread for safety.
        Object value = MainThread.call(plugin, () -> resolve(query, args), timeout);

        Boolean matched;
        if (expect != null) {
            try {
                matched = Predicates.evaluate(expect, value);
            } catch (RuntimeException e) {
                throw McTestException.assertFailed("Predicate evaluation failed for query '" + query
                        + "': " + e.getMessage());
            }
        } else {
            matched = null;
        }

        JsonObject result = new JsonObject();
        result.addProperty("ok", true);
        result.addProperty("query", query);
        result.add("value", Params.toJson(value));
        if (matched != null) {
            result.addProperty("matched", matched);
        } else {
            result.add("matched", com.google.gson.JsonNull.INSTANCE);
        }
        result.addProperty("valueJson", Params.toJson(value).toString());
        return result;
    }

    /** Resolves the query's value (server thread). Throws {@code ASSERT_FAILED} when unresolvable. */
    private Object resolve(String query, Map<String, Object> args) throws McTestException {
        // F5: loader-provided built-in (mod.loaded/plugin.loaded), resolved BEFORE the SUT provider so a
        // DOWNLOADED plugin/mod (no McTestStateProvider) can still be asserted present. Bukkit presence
        // is the PluginManager registry.
        Object builtin = BuiltInStateQueries.resolve(
                query, args, id -> Bukkit.getPluginManager().getPlugin(id) != null);
        if (builtin != BuiltInStateQueries.NOT_HANDLED) {
            return builtin;
        }
        McTestStateProvider provider = lookupProvider();
        if (provider != null) {
            try {
                return provider.query(query, args);
            } catch (Exception e) {
                throw McTestException.assertFailed("State query '" + query + "' failed: "
                        + e.getMessage());
            }
        }
        // No SUT provider: try the tiny built-in fallback grammar.
        return resolveFallback(query, args);
    }

    /** @return the first registered SUT {@link McTestStateProvider}, or {@code null}. */
    private McTestStateProvider lookupProvider() {
        RegisteredServiceProvider<McTestStateProvider> rsp =
                Bukkit.getServicesManager().getRegistration(McTestStateProvider.class);
        return rsp != null ? rsp.getProvider() : null;
    }

    /**
     * The fallback grammar for the handful of probes resolvable from the Bukkit API alone. Region
     * queries belong to the SUT provider; without it they are unknown → {@code ASSERT_FAILED}.
     */
    private Object resolveFallback(String query, Map<String, Object> args) throws McTestException {
        StateQuery q = StateQuery.parse(query);
        switch (q.namespace()) {
            case "config": {
                // config.get(<pluginName>, <path>) — read a config value from a loaded plugin.
                String pluginName = q.arg(0) != null ? q.arg(0) : str(args.get("plugin"));
                String path = q.arg(1) != null ? q.arg(1) : str(args.get("path"));
                if (pluginName == null || path == null) {
                    throw McTestException.assertFailed("config.get requires (plugin, path)");
                }
                Plugin target = Bukkit.getPluginManager().getPlugin(pluginName);
                if (target == null) {
                    throw McTestException.assertFailed("Plugin not found: " + pluginName);
                }
                return target.getConfig().get(path);
            }
            case "perms": {
                // perms.has(<playerName>, <node>) — permission check on an online player.
                String playerName = q.arg(0) != null ? q.arg(0) : str(args.get("player"));
                String node = q.arg(1) != null ? q.arg(1) : str(args.get("node"));
                if (playerName == null || node == null) {
                    throw McTestException.assertFailed("perms.has requires (player, node)");
                }
                Permissible permissible = Bukkit.getPlayerExact(playerName);
                if (permissible == null) {
                    OfflinePlayer offline = Bukkit.getOfflinePlayer(playerName);
                    throw McTestException.assertFailed("Player not online for perms.has: "
                            + offline.getName());
                }
                return permissible.hasPermission(node);
            }
            default:
                throw McTestException.assertFailed("Unknown state query (no provider registered): "
                        + query);
        }
    }

    private static String str(Object o) {
        return o != null ? o.toString() : null;
    }
}
