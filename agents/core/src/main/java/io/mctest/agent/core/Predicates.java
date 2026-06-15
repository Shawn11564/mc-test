package io.mctest.agent.core;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import java.util.Map;

/**
 * Pure predicate evaluator for {@code truth.assertPluginState}'s {@code expect} object (PROTOCOL.md
 * §7.5). Exactly one of {@code equals|notEquals|contains|gt|gte|lt|lte|exists} is honored; the agent
 * returns the boolean and the runner owns the verdict. No game/Bukkit types — unit-tested in isolation.
 */
public final class Predicates {

    private Predicates() {
    }

    /**
     * Evaluates {@code expect} against {@code value}.
     *
     * @param expect the {@code expect} object (e.g. {@code {"equals": true}}); the first recognized
     *               operator key wins.
     * @param value  the probe value (Java {@code Boolean}/{@code Number}/{@code String}/collection, or
     *               a Gson {@link JsonElement}).
     * @return whether the predicate holds.
     */
    public static boolean evaluate(JsonObject expect, Object value) {
        if (expect == null) {
            return false;
        }
        JsonElement v = toElement(value);

        if (expect.has("equals")) {
            return jsonEquals(v, expect.get("equals"));
        }
        if (expect.has("notEquals")) {
            return !jsonEquals(v, expect.get("notEquals"));
        }
        if (expect.has("exists")) {
            boolean exists = !(v == null || v.isJsonNull());
            return expect.get("exists").getAsBoolean() == exists;
        }
        if (expect.has("contains")) {
            return contains(v, expect.get("contains"));
        }
        if (expect.has("gt")) {
            return numericHolds(v, expect.get("gt"), "gt");
        }
        if (expect.has("gte")) {
            return numericHolds(v, expect.get("gte"), "gte");
        }
        if (expect.has("lt")) {
            return numericHolds(v, expect.get("lt"), "lt");
        }
        if (expect.has("lte")) {
            return numericHolds(v, expect.get("lte"), "lte");
        }
        return false;
    }

    /**
     * Numeric ordering predicate. An uncomparable (non-numeric) operand makes the predicate
     * honestly FALSE — never a spurious pass (a non-numeric value must not satisfy {@code gt}/{@code
     * gte}). {@code Double.compare(NaN, x)} ranks NaN as the largest double, which would otherwise
     * make {@code gt}/{@code gte} of a string value spuriously true.
     */
    private static boolean numericHolds(JsonElement v, JsonElement bound, String op) {
        double a = asNumber(v);
        double b = asNumber(bound);
        if (Double.isNaN(a) || Double.isNaN(b)) {
            return false;
        }
        int cmp = Double.compare(a, b);
        switch (op) {
            case "gt":
                return cmp > 0;
            case "gte":
                return cmp >= 0;
            case "lt":
                return cmp < 0;
            default:
                return cmp <= 0;
        }
    }

    private static boolean jsonEquals(JsonElement a, JsonElement b) {
        if (a == null || a.isJsonNull()) {
            return b == null || b.isJsonNull();
        }
        // Compare numbers numerically (1 == 1.0), everything else structurally.
        if (a.isJsonPrimitive() && b.isJsonPrimitive()) {
            JsonPrimitive pa = a.getAsJsonPrimitive();
            JsonPrimitive pb = b.getAsJsonPrimitive();
            if (pa.isNumber() && pb.isNumber()) {
                return pa.getAsDouble() == pb.getAsDouble();
            }
        }
        return a.equals(b);
    }

    private static boolean contains(JsonElement v, JsonElement needle) {
        if (v == null) {
            return false;
        }
        // Array containment.
        if (v.isJsonArray()) {
            JsonArray arr = v.getAsJsonArray();
            for (JsonElement el : arr) {
                if (jsonEquals(el, needle)) {
                    return true;
                }
            }
            return false;
        }
        // String substring containment.
        if (v.isJsonPrimitive() && needle.isJsonPrimitive()) {
            return v.getAsString().contains(needle.getAsString());
        }
        return false;
    }

    private static double asNumber(JsonElement el) {
        if (el == null || el.isJsonNull() || !el.isJsonPrimitive()) {
            return Double.NaN;
        }
        JsonPrimitive p = el.getAsJsonPrimitive();
        if (p.isNumber()) {
            return p.getAsDouble();
        }
        if (p.isBoolean()) {
            return p.getAsBoolean() ? 1.0 : 0.0;
        }
        try {
            return Double.parseDouble(p.getAsString());
        } catch (NumberFormatException e) {
            return Double.NaN;
        }
    }

    /** Coerces a plain Java value into a Gson element so the comparators have one shape. */
    @SuppressWarnings("unchecked")
    public static JsonElement toElement(Object value) {
        if (value == null) {
            return com.google.gson.JsonNull.INSTANCE;
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
        if (value instanceof String) {
            return new JsonPrimitive((String) value);
        }
        if (value instanceof Character) {
            return new JsonPrimitive(value.toString());
        }
        if (value instanceof Iterable) {
            JsonArray arr = new JsonArray();
            for (Object o : (Iterable<Object>) value) {
                arr.add(toElement(o));
            }
            return arr;
        }
        if (value instanceof Map) {
            JsonObject obj = new JsonObject();
            for (Map.Entry<Object, Object> e : ((Map<Object, Object>) value).entrySet()) {
                obj.add(String.valueOf(e.getKey()), toElement(e.getValue()));
            }
            return obj;
        }
        if (value instanceof Object[]) {
            JsonArray arr = new JsonArray();
            for (Object o : (Object[]) value) {
                arr.add(toElement(o));
            }
            return arr;
        }
        // Fallback: stringify unknown types.
        return new JsonPrimitive(value.toString());
    }
}
