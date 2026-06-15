package io.mctest.agent.core;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import java.util.Arrays;
import org.junit.jupiter.api.Test;

/** Unit tests for the pure {@code expect} predicate evaluator (PROTOCOL.md §7.5). */
class PredicatesTest {

    private static JsonObject expect(String op, Object value) {
        JsonObject o = new JsonObject();
        o.add(op, Predicates.toElement(value));
        return o;
    }

    @Test
    void equalsMatchesBoolean() {
        assertTrue(Predicates.evaluate(expect("equals", true), true));
        assertFalse(Predicates.evaluate(expect("equals", true), false));
    }

    @Test
    void equalsComparesNumbersNumerically() {
        assertTrue(Predicates.evaluate(expect("equals", 1), 1.0));
        assertTrue(Predicates.evaluate(expect("equals", 3), 3L));
        assertFalse(Predicates.evaluate(expect("equals", 3), 4));
    }

    @Test
    void notEqualsInverts() {
        assertTrue(Predicates.evaluate(expect("notEquals", "a"), "b"));
        assertFalse(Predicates.evaluate(expect("notEquals", "a"), "a"));
    }

    @Test
    void existsHonorsRequestedFlag() {
        assertTrue(Predicates.evaluate(expect("exists", true), "anything"));
        assertFalse(Predicates.evaluate(expect("exists", true), null));
        assertTrue(Predicates.evaluate(expect("exists", false), null));
        assertFalse(Predicates.evaluate(expect("exists", false), 5));
    }

    @Test
    void containsHandlesStringsAndArrays() {
        assertTrue(Predicates.evaluate(expect("contains", "Region"), "Region loaded"));
        assertFalse(Predicates.evaluate(expect("contains", "zzz"), "Region loaded"));
        assertTrue(Predicates.evaluate(expect("contains", "TestRegion"),
                Arrays.asList("A", "TestRegion", "B")));
        assertFalse(Predicates.evaluate(expect("contains", "Nope"),
                Arrays.asList("A", "B")));
    }

    @Test
    void numericComparators() {
        assertTrue(Predicates.evaluate(expect("gt", 5), 6));
        assertFalse(Predicates.evaluate(expect("gt", 5), 5));
        assertTrue(Predicates.evaluate(expect("gte", 5), 5));
        assertTrue(Predicates.evaluate(expect("lt", 5), 4));
        assertFalse(Predicates.evaluate(expect("lt", 5), 5));
        assertTrue(Predicates.evaluate(expect("lte", 5), 5));
    }

    @Test
    void numericComparatorsAreFalseForNonNumericValues() {
        // A non-numeric value must not spuriously satisfy gt/gte (Double.compare ranks NaN highest);
        // an uncomparable operand is an honest FALSE, never a false-green assertion.
        assertFalse(Predicates.evaluate(expect("gt", 5), "TestRegion"));
        assertFalse(Predicates.evaluate(expect("gte", 5), "TestRegion"));
        assertFalse(Predicates.evaluate(expect("lt", 5), "TestRegion"));
        assertFalse(Predicates.evaluate(expect("lte", 5), "TestRegion"));
        // A non-numeric bound is equally uncomparable.
        assertFalse(Predicates.evaluate(expect("gt", "x"), 5));
    }

    @Test
    void nullExpectIsFalse() {
        assertFalse(Predicates.evaluate(null, true));
    }
}
