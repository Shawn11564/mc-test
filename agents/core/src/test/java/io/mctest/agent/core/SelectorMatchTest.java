package io.mctest.agent.core;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import io.mctest.agent.core.ElementModel.Element;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

/** Unit tests for the AND selector matcher + normalization (PROTOCOL.md §7.3.1, SELECTORS.md §4.1). */
class SelectorMatchTest {

    private static JsonObject sel(String key, String value) {
        JsonObject o = new JsonObject();
        o.addProperty(key, value);
        return o;
    }

    private static List<Element> list(Element... els) {
        List<Element> out = new ArrayList<>();
        for (Element e : els) {
            out.add(e);
        }
        return out;
    }

    @Test
    void normalizeStripsColorCodesAndCaseFolds() {
        assertEquals("regions", SelectorMatch.normalize("§a§lRegions "));
        assertEquals("testregion", SelectorMatch.normalize("§7TestRegion§r"));
        assertEquals("regions list", SelectorMatch.normalize("  Regions   List  "));
    }

    @Test
    void labelMatchesAfterNormalization() {
        Element a = new Element("el_1", "button", "§aRegions");
        Element b = new Element("el_2", "button", "Other");
        List<Element> hits = SelectorMatch.match(list(a, b), sel("label", "regions"));
        assertEquals(1, hits.size());
        assertEquals("el_1", hits.get(0).elementId);
    }

    @Test
    void testIdIsExactNoNormalization() {
        Element a = new Element("el_1", "listItem", "TestRegion");
        a.testId = "regions:entry:TestRegion";
        List<Element> exact = SelectorMatch.match(list(a), sel("testId", "regions:entry:TestRegion"));
        assertEquals(1, exact.size());
        List<Element> wrongCase = SelectorMatch.match(list(a), sel("testId", "regions:entry:testregion"));
        assertTrue(wrongCase.isEmpty());
    }

    @Test
    void andOfKeysIntersects() {
        Element a = new Element("el_1", "button", "Regions");
        Element b = new Element("el_2", "listItem", "Regions");
        JsonObject selector = new JsonObject();
        selector.addProperty("label", "regions");
        selector.addProperty("role", "listItem");
        List<Element> hits = SelectorMatch.match(list(a, b), selector);
        assertEquals(1, hits.size());
        assertEquals("el_2", hits.get(0).elementId);
    }

    @Test
    void textContainsAndLoreContains() {
        Element a = new Element("el_1", "listItem", "TestRegion");
        a.lore.add("Click to load");
        List<Element> byText = SelectorMatch.match(list(a), sel("textContains", "region"));
        assertEquals(1, byText.size());
        List<Element> byLore = SelectorMatch.match(list(a), sel("loreContains", "load"));
        assertEquals(1, byLore.size());
        assertTrue(SelectorMatch.match(list(a), sel("loreContains", "absent")).isEmpty());
    }

    @Test
    void loreContainsArrayAndsEveryEntry() {
        Element a = new Element("el_1", "listItem", "TestRegion");
        a.lore.add("Click to load");
        a.lore.add("Owner: Tester");
        // Array form: ALL entries must be present (logical AND), not "matches everything".
        com.google.gson.JsonArray both = new com.google.gson.JsonArray();
        both.add("load");
        both.add("Owner");
        JsonObject allPresent = new JsonObject();
        allPresent.add("loreContains", both);
        assertEquals(1, SelectorMatch.match(list(a), allPresent).size());

        com.google.gson.JsonArray oneAbsent = new com.google.gson.JsonArray();
        oneAbsent.add("load");
        oneAbsent.add("absent");
        JsonObject missing = new JsonObject();
        missing.add("loreContains", oneAbsent);
        assertTrue(SelectorMatch.match(list(a), missing).isEmpty());
    }

    @Test
    void withinScopesToChildren() {
        Element list = new Element("el_list", "list", "Regions");
        list.testId = "regions:list";
        Element entry = new Element("el_entry", "listItem", "TestRegion");
        Element decoy = new Element("el_decoy", "listItem", "TestRegion");
        list.children.add(entry);

        JsonObject within = new JsonObject();
        within.addProperty("testId", "regions:list");
        JsonObject selector = new JsonObject();
        selector.add("within", within);
        selector.addProperty("label", "testregion");

        List<Element> hits = SelectorMatch.match(list(list, decoy), selector);
        assertEquals(1, hits.size());
        assertEquals("el_entry", hits.get(0).elementId);
    }

    @Test
    void nthDisambiguates() {
        Element a = new Element("el_1", "listItem", "Same");
        Element b = new Element("el_2", "listItem", "Same");
        JsonObject selector = new JsonObject();
        selector.addProperty("role", "listItem");
        selector.addProperty("nth", 1);
        List<Element> hits = SelectorMatch.match(list(a, b), selector);
        assertEquals(1, hits.size());
        assertEquals("el_2", hits.get(0).elementId);
    }
}
