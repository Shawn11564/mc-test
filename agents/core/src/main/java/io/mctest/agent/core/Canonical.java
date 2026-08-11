package io.mctest.agent.core;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

/**
 * Canonical JSON serialization + a stable digest over it.
 *
 * <p>This is what makes item identity comparable across the wire. Two item stacks are "the same
 * item" only if the agent saw the same {@code type} AND the same data components; a modded item (a
 * Cobblemon Poké Ball, a ChestShop sign item) is a vanilla material plus components, so comparing
 * materials alone would call it equal to a plain one. Hashing requires a byte-stable rendering:
 * object keys sorted, no insignificant whitespace, integral doubles written without a trailing
 * {@code .0} — otherwise the same item hashes differently between two reads and every assertion
 * becomes flaky.
 *
 * <p>Deliberately free of any Bukkit/Minecraft type so it is unit-testable with no server.
 */
public final class Canonical {

    private Canonical() {
    }

    /** Renders a Gson element in canonical form (keys sorted, no whitespace). */
    public static String json(JsonElement element) {
        StringBuilder out = new StringBuilder();
        write(element, out);
        return out.toString();
    }

    private static void write(JsonElement element, StringBuilder out) {
        if (element == null || element.isJsonNull()) {
            out.append("null");
            return;
        }
        if (element.isJsonObject()) {
            JsonObject obj = element.getAsJsonObject();
            List<String> keys = new ArrayList<>(obj.keySet());
            Collections.sort(keys);
            out.append('{');
            boolean first = true;
            for (String key : keys) {
                if (!first) {
                    out.append(',');
                }
                first = false;
                out.append(quote(key)).append(':');
                write(obj.get(key), out);
            }
            out.append('}');
            return;
        }
        if (element.isJsonArray()) {
            JsonArray arr = element.getAsJsonArray();
            out.append('[');
            for (int i = 0; i < arr.size(); i++) {
                if (i > 0) {
                    out.append(',');
                }
                write(arr.get(i), out);
            }
            out.append(']');
            return;
        }
        JsonPrimitive prim = element.getAsJsonPrimitive();
        if (prim.isBoolean()) {
            out.append(prim.getAsBoolean() ? "true" : "false");
            return;
        }
        if (prim.isNumber()) {
            double d = prim.getAsDouble();
            // Integral values render without a trailing ".0" so 5 and 5.0 hash identically —
            // Gson's number handling varies by construction path and must not leak into the digest.
            if (d == Math.rint(d) && !Double.isInfinite(d) && Math.abs(d) < 9.007199254740992E15) {
                out.append(Long.toString((long) d));
            } else {
                out.append(Double.toString(d));
            }
            return;
        }
        out.append(quote(prim.getAsString()));
    }

    private static String quote(String raw) {
        return new JsonPrimitive(raw).toString();
    }

    /**
     * A stable {@code sha256:<hex>} digest over the canonical form of {@code type} + {@code
     * components}. Equal digests mean the agent saw identical stacks; different digests mean the
     * items genuinely differ.
     */
    public static String itemHash(String type, JsonElement components) {
        JsonObject identity = new JsonObject();
        identity.addProperty("type", type == null ? "" : type);
        identity.add("components", components == null ? JsonNull.INSTANCE : components);
        return sha256(json(identity));
    }

    /** {@code sha256:<lowercase hex>} of the UTF-8 bytes of {@code text}. */
    public static String sha256(String text) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] bytes = digest.digest(text.getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder(bytes.length * 2 + 7);
            hex.append("sha256:");
            for (byte b : bytes) {
                hex.append(Character.forDigit((b >> 4) & 0xF, 16));
                hex.append(Character.forDigit(b & 0xF, 16));
            }
            return hex.toString();
        } catch (NoSuchAlgorithmException e) {
            // SHA-256 is mandated by every JRE; treat absence as unrecoverable rather than
            // silently degrading to a weaker (or absent) identity token.
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
    }

    /**
     * Recursively coerces an arbitrary Java value into JSON for the component map. Maps and
     * iterables recurse; enums render as their {@code name()}; anything else falls back to
     * {@code toString()} — a lossy but deterministic rendering, which is what the digest needs.
     */
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
        if (value instanceof Enum<?>) {
            return new JsonPrimitive(((Enum<?>) value).name());
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
