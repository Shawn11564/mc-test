package io.mctest.agent.serverfabric.truth;

import com.google.gson.JsonObject;
import io.mctest.agent.core.McTestException;
import io.mctest.agent.core.McTestSession;
import io.mctest.agent.core.McTestStateProvider;
import io.mctest.agent.core.Predicates;
import io.mctest.agent.serverfabric.Params;
import io.mctest.agent.serverfabric.mappings.Names;
import java.util.Map;

/**
 * {@code truth.assertPluginState} — reads authoritative mod state for assertions (PROTOCOL.md §7.5,
 * cap {@code pluginState}). The agent fetches/evaluates only; the runner owns the verdict.
 *
 * <p>Same handler skeleton as the {@code server-bukkit} agent, but the provider is discovered through
 * {@link Names#lookupStateProvider()} (a {@link java.util.ServiceLoader} lookup — the Fabric discovery
 * mechanism, since there is no Bukkit {@code ServicesManager}) and the probe runs on the server thread
 * via {@link Names#call}.
 *
 * <p>Resolution order:
 * <ol>
 *   <li><b>Preferred:</b> the SUT's {@link McTestStateProvider}, resolved via
 *       {@link java.util.ServiceLoader} (the SUT mod and agent share the same class via the bundled
 *       core).</li>
 *   <li><b>Fallback grammar</b> (when no provider is registered): a vanilla Fabric server exposes no
 *       plugin config / permission API like Bukkit, so any query without a provider is unknown →
 *       {@code -32006 ASSERT_FAILED}.</li>
 * </ol>
 * Unknown query or an evaluation failure → {@code -32006 ASSERT_FAILED}.
 */
public final class PluginStateProbe {

    private final Names names;

    public PluginStateProbe(Names names) {
        this.names = names;
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

        // Provider probes touch mod state; run on the server thread for safety.
        Object value = names.call(() -> resolve(query, args), timeout);

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
        McTestStateProvider provider = names.lookupStateProvider();
        if (provider != null) {
            try {
                return provider.query(query, args);
            } catch (Exception e) {
                throw McTestException.assertFailed("State query '" + query + "' failed: "
                        + e.getMessage());
            }
        }
        // No SUT provider registered. Parse to surface the head in the error for diagnostics; a vanilla
        // Fabric server has no Bukkit-style config/perms fallback, so the query is unknown.
        StateQuery q = StateQuery.parse(query);
        throw McTestException.assertFailed("Unknown state query (no provider registered): "
                + q.head);
    }
}
