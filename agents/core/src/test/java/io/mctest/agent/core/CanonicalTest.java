package io.mctest.agent.core;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * The canonicalizer underpins item identity: a stack's {@code componentsHash} must depend on WHAT
 * the components are, never on the order Gson happened to build them in or how a number was typed.
 * If that were false, "this item only equals itself" would be flaky rather than true.
 */
class CanonicalTest {

    @Test
    @DisplayName("object key order never changes the canonical form or the digest")
    void keyOrderIsIrrelevant() {
        JsonObject a = new JsonObject();
        a.addProperty("display-name", "Excalibur");
        a.addProperty("meta-type", "UNSPECIFIC");

        JsonObject b = new JsonObject();
        b.addProperty("meta-type", "UNSPECIFIC");
        b.addProperty("display-name", "Excalibur");

        assertEquals(Canonical.json(a), Canonical.json(b));
        assertEquals(Canonical.itemHash("minecraft:diamond_sword", a),
                Canonical.itemHash("minecraft:diamond_sword", b));
    }

    @Test
    @DisplayName("array order DOES matter (an NBT list is ordered data)")
    void arrayOrderMatters() {
        JsonArray a = new JsonArray();
        a.add("line one");
        a.add("line two");
        JsonArray b = new JsonArray();
        b.add("line two");
        b.add("line one");
        assertNotEquals(Canonical.json(a), Canonical.json(b));
    }

    @Test
    @DisplayName("integral numbers render without a trailing .0 so 5 and 5.0 hash alike")
    void integralNumbersAreStable() {
        JsonObject fromInt = new JsonObject();
        fromInt.addProperty("levels", 5);
        JsonObject fromDouble = new JsonObject();
        fromDouble.addProperty("levels", 5.0d);
        assertEquals("{\"levels\":5}", Canonical.json(fromInt));
        assertEquals(Canonical.json(fromInt), Canonical.json(fromDouble));
    }

    @Test
    @DisplayName("the same material with different components hashes differently")
    void componentsAreIdentity() {
        JsonObject plain = new JsonObject();
        plain.addProperty("meta-type", "UNSPECIFIC");

        JsonObject named = new JsonObject();
        named.addProperty("meta-type", "UNSPECIFIC");
        named.addProperty("display-name", "Excalibur");

        String plainHash = Canonical.itemHash("minecraft:diamond_sword", plain);
        String namedHash = Canonical.itemHash("minecraft:diamond_sword", named);
        assertNotEquals(namedHash, plainHash,
                "a named sword must not be identified as a plain one");
        assertEquals(plainHash, Canonical.itemHash("minecraft:diamond_sword", plain),
                "the digest must be stable across reads");
    }

    @Test
    @DisplayName("the same components on a different material hash differently")
    void typeIsPartOfIdentity() {
        JsonObject components = new JsonObject();
        components.addProperty("display-name", "Excalibur");
        assertNotEquals(Canonical.itemHash("minecraft:diamond_sword", components),
                Canonical.itemHash("minecraft:stone_sword", components));
    }

    @Test
    @DisplayName("digests are the documented sha256:<hex> shape")
    void digestShape() {
        String hash = Canonical.sha256("anything");
        assertTrue(hash.startsWith("sha256:"), hash);
        assertEquals("sha256:".length() + 64, hash.length(), hash);
    }

    @Test
    @DisplayName("nested maps/lists/enums coerce to plain JSON")
    void coercion() {
        Map<String, Object> nested = new LinkedHashMap<>();
        nested.put("enchants", Map.of("SHARPNESS", 5));
        nested.put("lore", java.util.List.of("a", "b"));
        nested.put("kind", java.util.concurrent.TimeUnit.SECONDS);
        String json = Canonical.json(Canonical.toJson(nested));
        assertEquals("{\"enchants\":{\"SHARPNESS\":5},\"kind\":\"SECONDS\",\"lore\":[\"a\",\"b\"]}", json);
    }
}
