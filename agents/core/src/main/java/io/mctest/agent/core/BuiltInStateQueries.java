package io.mctest.agent.core;

import java.util.Map;

/**
 * Loader-provided, SUT-agnostic built-in queries for {@code truth.assertPluginState} (F5).
 *
 * <p>The reserved query names {@code mod.loaded} / {@code plugin.loaded} (synonyms — either works on
 * any loader) resolve a mod/plugin's PRESENCE from the loader itself, so a <strong>downloaded
 * third-party mod</strong> that registers no {@link McTestStateProvider} SPI can still be asserted
 * loaded. Each agent's {@code PluginStateProbe} calls {@link #resolve} BEFORE its SUT-provider lookup;
 * a non-reserved query returns {@link #NOT_HANDLED} and falls through to the existing resolution.
 *
 * <p>Pure Java — no game/loader types (the loader call is injected as a {@link LoaderPresence}). The id
 * comes from {@code args.id} or the head-arg shorthand {@code mod.loaded(<id>)} (mirrors the existing
 * {@code namespace.verb(args…)} query grammar).
 */
public final class BuiltInStateQueries {

    private BuiltInStateQueries() {}

    /** Sentinel returned by {@link #resolve} when the query is not a reserved built-in. */
    public static final Object NOT_HANDLED = new Object();

    /** @return true if {@code query}'s head is a reserved built-in ({@code mod.loaded}/{@code plugin.loaded}). */
    public static boolean isReserved(String query) {
        String head = head(query);
        return head.equals("mod.loaded") || head.equals("plugin.loaded");
    }

    /**
     * Resolve a reserved built-in against the loader.
     *
     * @return the boolean presence value, or {@link #NOT_HANDLED} if {@code query} is not reserved.
     * @throws McTestException if reserved but no id was supplied (via {@code args.id} or {@code (<id>)}).
     */
    public static Object resolve(String query, Map<String, Object> args, LoaderPresence presence)
            throws McTestException {
        if (!isReserved(query)) {
            return NOT_HANDLED;
        }
        String id = extractId(query, args);
        if (id == null || id.isEmpty()) {
            throw McTestException.assertFailed(head(query) + " requires a mod/plugin id "
                    + "(args.id or " + head(query) + "(<id>))");
        }
        return presence.isLoaded(id);
    }

    /** The head (before any {@code (}) of a query string. */
    private static String head(String query) {
        if (query == null) {
            return "";
        }
        int paren = query.indexOf('(');
        return (paren >= 0 ? query.substring(0, paren) : query).trim();
    }

    /** The id from {@code args.id}, else the parenthesised head-arg {@code mod.loaded(<id>)}. */
    private static String extractId(String query, Map<String, Object> args) {
        Object fromArgs = args != null ? args.get("id") : null;
        if (fromArgs != null && !fromArgs.toString().isEmpty()) {
            return fromArgs.toString();
        }
        if (query == null) {
            return null;
        }
        int lp = query.indexOf('(');
        int rp = query.lastIndexOf(')');
        if (lp >= 0 && rp > lp) {
            String inner = query.substring(lp + 1, rp).trim();
            if (inner.length() >= 2
                    && (inner.charAt(0) == '"' || inner.charAt(0) == '\'')
                    && inner.charAt(inner.length() - 1) == inner.charAt(0)) {
                inner = inner.substring(1, inner.length() - 1);
            }
            return inner.isEmpty() ? null : inner;
        }
        return null;
    }
}
