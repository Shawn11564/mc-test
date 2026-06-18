package io.mctest.agent.core;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * F5 — the loader-provided {@code mod.loaded}/{@code plugin.loaded} built-in query. Pure (the loader
 * call is injected as a {@link LoaderPresence}), so it is gated in the fast CI {@code jvm} job.
 */
class BuiltInStateQueriesTest {

    /** A fake loader where only the seeded ids are "loaded". */
    private static LoaderPresence loaded(String... ids) {
        Set<String> set = Set.of(ids);
        return set::contains;
    }

    @Test
    void recognizesReservedHeads() {
        assertTrue(BuiltInStateQueries.isReserved("mod.loaded"));
        assertTrue(BuiltInStateQueries.isReserved("plugin.loaded"));
        assertTrue(BuiltInStateQueries.isReserved("mod.loaded(ferritecore)"));
        assertFalse(BuiltInStateQueries.isReserved("regions.exists"));
        assertFalse(BuiltInStateQueries.isReserved("config.get"));
    }

    @Test
    void nonReservedReturnsNotHandled() throws Exception {
        Object r = BuiltInStateQueries.resolve("regions.exists", Map.of("name", "X"), loaded("ferritecore"));
        assertSame(BuiltInStateQueries.NOT_HANDLED, r);
    }

    @Test
    void resolvesPresenceFromArgsId() throws Exception {
        LoaderPresence loader = loaded("ferritecore");
        assertEquals(true, BuiltInStateQueries.resolve("mod.loaded", Map.of("id", "ferritecore"), loader));
        assertEquals(false, BuiltInStateQueries.resolve("mod.loaded", Map.of("id", "nope"), loader));
    }

    @Test
    void resolvesPresenceFromHeadArgShorthand() throws Exception {
        LoaderPresence loader = loaded("ferritecore");
        assertEquals(true, BuiltInStateQueries.resolve("mod.loaded(ferritecore)", Map.of(), loader));
        assertEquals(true, BuiltInStateQueries.resolve("plugin.loaded('ferritecore')", Map.of(), loader));
        assertEquals(false, BuiltInStateQueries.resolve("mod.loaded(other)", Map.of(), loader));
    }

    @Test
    void missingIdIsAssertFailed() {
        assertThrows(McTestException.class,
                () -> BuiltInStateQueries.resolve("mod.loaded", Map.of(), loaded("ferritecore")));
    }
}
