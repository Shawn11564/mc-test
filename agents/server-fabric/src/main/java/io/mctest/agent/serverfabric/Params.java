package io.mctest.agent.serverfabric;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import io.mctest.agent.core.McTestException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Pure JSON → typed-param helpers shared by the handlers. Kept game-free (only Gson) so the
 * parsing/coercion logic is unit-testable without a server runtime. {@link #toArgs} converts an MCTP
 * {@code args}/{@code params} object into the plain {@code Map<String,Object>} the pure-Java SPIs
 * ({@code McTestStateProvider}/{@code McTestFixtureProvider}) consume.
 *
 * <p>Copied verbatim from the {@code server-bukkit} agent (it is pure Java with no game types) so the
 * two server agents share identical coercion semantics. Do not re-derive — reuse.
 */
public final class Params {

    private Params() {
    }

    /** @return the string at {@code key}, or {@code def} if absent/null. */
    public static String optString(JsonObject p, String key, String def) {
        if (p != null && p.has(key) && p.get(key).isJsonPrimitive()) {
            return p.get(key).getAsString();
        }
        return def;
    }

    /** @return the string at {@code key}; → {@code -32602} if missing/empty. */
    public static String requireString(JsonObject p, String key) throws McTestException {
        String v = optString(p, key, null);
        if (v == null || v.isEmpty()) {
            throw McTestException.invalidParams("Missing required string param: " + key);
        }
        return v;
    }

    /** @return the integer at {@code key}; → {@code -32602} if missing or not a number. */
    public static int requireInt(JsonObject p, String key) throws McTestException {
        if (p == null || !p.has(key) || !p.get(key).isJsonPrimitive()
                || !p.getAsJsonPrimitive(key).isNumber()) {
            throw McTestException.invalidParams("Missing required numeric param: " + key);
        }
        return p.get(key).getAsInt();
    }

    /** @return the double at {@code key}, or {@code def} if absent/not numeric. */
    public static double optDouble(JsonObject p, String key, double def) {
        if (p != null && p.has(key) && p.get(key).isJsonPrimitive()
                && p.getAsJsonPrimitive(key).isNumber()) {
            return p.get(key).getAsDouble();
        }
        return def;
    }

    /** @return the nested object at {@code key}, or {@code null}. */
    public static JsonObject optObject(JsonObject p, String key) {
        if (p != null && p.has(key) && p.get(key).isJsonObject()) {
            return p.getAsJsonObject(key);
        }
        return null;
    }

    /**
     * Reads the per-call {@code timeoutMs}, falling back to {@code def}. The agent uses this as the
     * main-thread bounce budget.
     */
    public static long timeoutMs(JsonObject p, long def) {
        if (p != null && p.has("timeoutMs") && p.get("timeoutMs").isJsonPrimitive()
                && p.getAsJsonPrimitive("timeoutMs").isNumber()) {
            long v = p.get("timeoutMs").getAsLong();
            if (v > 0) {
                return v;
            }
        }
        return def;
    }

    /**
     * Converts a JSON object into a plain {@code Map<String,Object>} (recursively), so the pure-Java
     * SPIs never see a Gson type. JSON numbers become {@link Double}/{@link Long}, booleans/strings
     * map directly, arrays become {@link List}, nested objects become nested maps, null becomes Java
     * {@code null}.
     */
    public static Map<String, Object> toArgs(JsonObject obj) {
        Map<String, Object> out = new LinkedHashMap<>();
        if (obj == null) {
            return out;
        }
        for (Map.Entry<String, JsonElement> e : obj.entrySet()) {
            out.put(e.getKey(), fromJson(e.getValue()));
        }
        return out;
    }

    /** Recursively coerces a Gson element into a plain Java value. */
    public static Object fromJson(JsonElement el) {
        if (el == null || el.isJsonNull()) {
            return null;
        }
        if (el.isJsonObject()) {
            return toArgs(el.getAsJsonObject());
        }
        if (el.isJsonArray()) {
            List<Object> list = new ArrayList<>();
            for (JsonElement child : el.getAsJsonArray()) {
                list.add(fromJson(child));
            }
            return list;
        }
        JsonPrimitive prim = el.getAsJsonPrimitive();
        if (prim.isBoolean()) {
            return prim.getAsBoolean();
        }
        if (prim.isNumber()) {
            // Preserve integrality where possible (region counts etc.), else keep a double.
            double d = prim.getAsDouble();
            if (d == Math.rint(d) && !Double.isInfinite(d)
                    && Math.abs(d) < 9.007199254740992E15) {
                return prim.getAsLong();
            }
            return d;
        }
        return prim.getAsString();
    }

    /** Coerces an arbitrary pure-Java SPI return value into a Gson element for the wire result. */
    public static JsonElement toJson(Object value) {
        if (value == null) {
            return JsonNull.INSTANCE;
        }
        if (value instanceof JsonElement) {
            return (JsonElement) value;
        }
        if (value instanceof Boolean) {
            return new JsonPrimitive((Boolean) value);
        }
        if (value instanceof Number) {
            return new JsonPrimitive((Number) value);
        }
        if (value instanceof CharSequence || value instanceof Character) {
            return new JsonPrimitive(value.toString());
        }
        if (value instanceof Map<?, ?>) {
            JsonObject obj = new JsonObject();
            for (Map.Entry<?, ?> e : ((Map<?, ?>) value).entrySet()) {
                obj.add(String.valueOf(e.getKey()), toJson(e.getValue()));
            }
            return obj;
        }
        if (value instanceof Iterable<?>) {
            JsonArray arr = new JsonArray();
            for (Object o : (Iterable<?>) value) {
                arr.add(toJson(o));
            }
            return arr;
        }
        if (value instanceof Object[]) {
            JsonArray arr = new JsonArray();
            for (Object o : (Object[]) value) {
                arr.add(toJson(o));
            }
            return arr;
        }
        return new JsonPrimitive(value.toString());
    }
}
