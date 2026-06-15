package io.mctest.agent.core;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Minimal semver-ish MC-version matcher for {@code session.create} constraints (PROTOCOL.md §4.2 /
 * §5.1; mirrors the runner's {@code mcVersionRangesIntersect} in {@code @mc-test/protocol}). Tests
 * whether a single dotted version (e.g. {@code "1.20.4"}) satisfies a space-ANDed range of
 * comparators ({@code >=}, {@code >}, {@code <=}, {@code <}, {@code =}), a bare exact version, or the
 * wildcards {@code "*"}/{@code "any"}. Unknown tokens are ignored (lenient, matching the runner).
 */
public final class VersionRange {

    private static final Pattern TOKEN = Pattern.compile("^(>=|<=|>|<|=)?\\s*v?(\\d+(?:\\.\\d+)*)$");

    private VersionRange() {
    }

    /** Whether {@code version} falls within {@code range}. A null version/range is treated as "any". */
    public static boolean satisfies(String version, String range) {
        if (version == null || range == null) {
            return true;
        }
        String r = range.trim();
        if (r.isEmpty() || r.equals("*") || r.equalsIgnoreCase("any")) {
            return true;
        }
        for (String token : r.split("\\s+")) {
            if (!satisfiesToken(version, token)) {
                return false;
            }
        }
        return true;
    }

    private static boolean satisfiesToken(String version, String token) {
        Matcher m = TOKEN.matcher(token.trim());
        if (!m.matches()) {
            return true; // ignore unrecognized tokens (lenient)
        }
        String op = m.group(1) == null ? "=" : m.group(1);
        int cmp = compare(version, m.group(2));
        switch (op) {
            case ">=":
                return cmp >= 0;
            case ">":
                return cmp > 0;
            case "<=":
                return cmp <= 0;
            case "<":
                return cmp < 0;
            default: // "="
                return cmp == 0;
        }
    }

    /** Numerically compares two dotted versions ({@code -1}/{@code 0}/{@code 1}). */
    public static int compare(String a, String b) {
        String[] pa = a.split("\\.");
        String[] pb = b.split("\\.");
        int len = Math.max(pa.length, pb.length);
        for (int i = 0; i < len; i++) {
            int na = i < pa.length ? parse(pa[i]) : 0;
            int nb = i < pb.length ? parse(pb[i]) : 0;
            if (na != nb) {
                return Integer.compare(na, nb);
            }
        }
        return 0;
    }

    private static int parse(String s) {
        try {
            return Integer.parseInt(s);
        } catch (NumberFormatException e) {
            return 0;
        }
    }
}
