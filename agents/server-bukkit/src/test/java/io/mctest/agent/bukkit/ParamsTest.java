package io.mctest.agent.bukkit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import io.mctest.agent.core.McTestException;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * Pure JSON ↔ typed-param coercion tests for {@link Params} — Gson only, no Bukkit. Covers the
 * {@code args} → {@code Map<String,Object>} bridge the SUT SPIs consume and the required/optional
 * getters' error behavior.
 *
 * <p>Requires Gson on the test classpath (Paper provides it at runtime; add
 * {@code testImplementation("com.google.code.gson:gson")} to the build to run this suite).
 */
class ParamsTest {

    private JsonObject obj(String json) {
        return JsonParser.parseString(json).getAsJsonObject();
    }

    @Test
    void toArgsCoercesScalarsAndNesting() {
        JsonObject p = obj("{\"name\":\"TestRegion\",\"flag\":true,\"count\":3,"
                + "\"ratio\":1.5,\"min\":{\"x\":0,\"y\":60},\"tags\":[\"a\",\"b\"],\"none\":null}");
        Map<String, Object> args = Params.toArgs(p);

        assertEquals("TestRegion", args.get("name"));
        assertEquals(Boolean.TRUE, args.get("flag"));
        // Integral numbers preserve integrality as Long.
        assertEquals(3L, args.get("count"));
        assertEquals(1.5, args.get("ratio"));
        assertInstanceOf(Map.class, args.get("min"));
        assertEquals(0L, ((Map<?, ?>) args.get("min")).get("x"));
        assertInstanceOf(List.class, args.get("tags"));
        assertEquals(List.of("a", "b"), args.get("tags"));
        assertTrue(args.containsKey("none"));
        assertNull(args.get("none"));
    }

    @Test
    void requireStringRejectsMissing() {
        JsonObject p = obj("{}");
        McTestException ex = assertThrows(McTestException.class, () -> Params.requireString(p, "fixture"));
        assertEquals(-32602, ex.code);
    }

    @Test
    void requireIntRejectsNonNumberButReadsNumbers() throws McTestException {
        JsonObject p = obj("{\"x\":\"nope\"}");
        assertThrows(McTestException.class, () -> Params.requireInt(p, "x"));
        assertEquals(7, Params.requireInt(obj("{\"x\":7}"), "x"));
    }

    @Test
    void timeoutMsFallsBackToDefault() {
        assertEquals(15000L, Params.timeoutMs(obj("{}"), 15000));
        assertEquals(2000L, Params.timeoutMs(obj("{\"timeoutMs\":2000}"), 15000));
        // Non-positive timeouts are ignored.
        assertEquals(15000L, Params.timeoutMs(obj("{\"timeoutMs\":0}"), 15000));
    }

    @Test
    void toJsonRoundTripsCommonTypes() {
        assertEquals("true", Params.toJson(Boolean.TRUE).toString());
        assertEquals("\"TestRegion\"", Params.toJson("TestRegion").toString());
        assertEquals("null", Params.toJson(null).toString());
        assertEquals("[1,2]", Params.toJson(List.of(1, 2)).toString());
    }

    @Test
    void optObjectReturnsNullWhenAbsentOrWrongType() {
        assertNull(Params.optObject(obj("{}"), "args"));
        assertNull(Params.optObject(obj("{\"args\":5}"), "args"));
        assertFalse(Params.optObject(obj("{\"args\":{\"a\":1}}"), "args").entrySet().isEmpty());
    }
}
