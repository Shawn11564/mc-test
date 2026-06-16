package io.mctest.agent.serverfabric.truth;

import java.util.ArrayList;
import java.util.List;

/**
 * Pure parse of the small fallback plugin-state expression grammar used by {@link PluginStateProbe}
 * when no {@code McTestStateProvider} is registered. Game-free so it is unit-testable.
 *
 * <p>Grammar (mirrors the wire {@code query} string): a dotted {@code namespace.verb} head, optionally
 * followed by a parenthesised argument list, e.g. {@code "config.get(regions.maxPerPlayer)"},
 * {@code "perms.has(Tester, openregions.use)"}, {@code "regions.exists(TestRegion)"}. Bare queries with
 * no parens (the SPI-routed form) parse to an empty arg list.
 *
 * <p>Copied verbatim from the {@code server-bukkit} agent (it is pure Java with no game types) so the
 * two server agents share identical grammar. Do not re-derive — reuse.
 */
final class StateQuery {

    final String head;
    final List<String> args;

    private StateQuery(String head, List<String> args) {
        this.head = head;
        this.args = args;
    }

    /** @return the namespace segment of the head (before the first {@code .}), or the whole head. */
    String namespace() {
        int dot = head.indexOf('.');
        return dot >= 0 ? head.substring(0, dot) : head;
    }

    /** @return the verb segment of the head (after the first {@code .}), or {@code ""}. */
    String verb() {
        int dot = head.indexOf('.');
        return dot >= 0 ? head.substring(dot + 1) : "";
    }

    /** @return the positional argument at {@code i}, or {@code null} if absent. */
    String arg(int i) {
        return i >= 0 && i < args.size() ? args.get(i) : null;
    }

    /**
     * Parses a query string into a head + positional args. Never throws: a malformed string yields a
     * best-effort head with no args (the probe then reports {@code ASSERT_FAILED} for an unknown head).
     */
    static StateQuery parse(String query) {
        if (query == null) {
            return new StateQuery("", new ArrayList<>());
        }
        String trimmed = query.trim();
        int open = trimmed.indexOf('(');
        if (open < 0) {
            return new StateQuery(trimmed, new ArrayList<>());
        }
        int close = trimmed.lastIndexOf(')');
        String head = trimmed.substring(0, open).trim();
        List<String> args = new ArrayList<>();
        if (close > open) {
            String inner = trimmed.substring(open + 1, close).trim();
            if (!inner.isEmpty()) {
                for (String part : inner.split(",")) {
                    String a = part.trim();
                    // Strip a single layer of surrounding quotes if present.
                    if (a.length() >= 2 && (a.charAt(0) == '"' || a.charAt(0) == '\'')
                            && a.charAt(a.length() - 1) == a.charAt(0)) {
                        a = a.substring(1, a.length() - 1);
                    }
                    args.add(a);
                }
            }
        }
        return new StateQuery(head, args);
    }
}
