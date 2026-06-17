package io.mctest.agent.serverfabric.truth;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

/**
 * Pure parse tests for the server-fabric {@link StateQuery} — the fallback plugin-state expression
 * grammar used by {@code PluginStateProbe} when no {@code McTestStateProvider} is registered. No Fabric
 * runtime. Mirrors the server-bukkit suite (shared verbatim grammar) and pins server-fabric's copy.
 */
class StateQueryTest {

    @Test
    void bareDottedQueryHasNoArgs() {
        StateQuery q = StateQuery.parse("regions.exists");
        assertEquals("regions.exists", q.head);
        assertEquals("regions", q.namespace());
        assertEquals("exists", q.verb());
        assertTrue(q.args.isEmpty());
        assertNull(q.arg(0));
    }

    @Test
    void parenthesisedArgsAreSplitAndTrimmed() {
        StateQuery q = StateQuery.parse("perms.has( Tester , openregions.use )");
        assertEquals("perms.has", q.head);
        assertEquals("perms", q.namespace());
        assertEquals("has", q.verb());
        assertEquals("Tester", q.arg(0));
        assertEquals("openregions.use", q.arg(1));
    }

    @Test
    void quotedArgsAreUnquoted() {
        StateQuery q = StateQuery.parse("config.get(\"OpenRegions\", 'regions.max')");
        assertEquals("OpenRegions", q.arg(0));
        assertEquals("regions.max", q.arg(1));
    }

    @Test
    void emptyArgListYieldsNoArgs() {
        StateQuery q = StateQuery.parse("regions.count()");
        assertEquals("regions.count", q.head);
        assertTrue(q.args.isEmpty());
    }

    @Test
    void nullAndMalformedAreSafe() {
        StateQuery n = StateQuery.parse(null);
        assertEquals("", n.head);
        assertTrue(n.args.isEmpty());

        // Missing close paren: best-effort head, no args.
        StateQuery m = StateQuery.parse("foo.bar(");
        assertEquals("foo.bar", m.head);
        assertTrue(m.args.isEmpty());
    }

    @Test
    void headWithoutDotHasEmptyVerb() {
        StateQuery q = StateQuery.parse("ping");
        assertEquals("ping", q.namespace());
        assertEquals("", q.verb());
    }
}
