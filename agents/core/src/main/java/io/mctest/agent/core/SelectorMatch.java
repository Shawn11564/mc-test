package io.mctest.agent.core;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import io.mctest.agent.core.ElementModel.Element;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.List;

/**
 * AND-matches a semantic selector object against a candidate element list (PROTOCOL.md §7.3.1,
 * grammar in SELECTORS.md). Minimal-but-real: implements the normalization pipeline (SELECTORS.md
 * §4.1), exact/contains predicates, the {@code role}/{@code itemType}/{@code testId} predicates,
 * {@code within} scoping, and {@code nth}/{@code index} disambiguation. Fuzzy scoring is deferred to
 * M4; this is the deterministic exact-after-normalize tier.
 */
public final class SelectorMatch {

    private SelectorMatch() {
    }

    /**
     * Returns every element satisfying ALL present selector keys (logical AND), after applying
     * {@code within} scoping and {@code nth}/{@code index} disambiguation.
     */
    public static List<Element> match(List<Element> candidates, JsonObject selector) {
        if (candidates == null) {
            return new ArrayList<>();
        }
        if (selector == null || selector.size() == 0) {
            return new ArrayList<>(candidates);
        }

        // 1. within: resolve the scope container, then restrict to its children (SELECTORS.md §3.6).
        List<Element> pool = candidates;
        if (selector.has("within") && selector.get("within").isJsonObject()) {
            List<Element> scopes = match(candidates, selector.getAsJsonObject("within"));
            pool = new ArrayList<>();
            for (Element scope : scopes) {
                pool.addAll(scope.children);
            }
        }

        // 2. filter by every remaining predicate.
        List<Element> matched = new ArrayList<>();
        for (Element c : pool) {
            if (matches(c, selector)) {
                matched.add(c);
            }
        }

        // 3. nth / index disambiguation (aliases) applied after filtering.
        Integer ordinal = readInt(selector, "nth");
        if (ordinal == null) {
            ordinal = readInt(selector, "index");
        }
        if (ordinal != null) {
            List<Element> picked = new ArrayList<>();
            if (ordinal >= 0 && ordinal < matched.size()) {
                picked.add(matched.get(ordinal));
            }
            return picked;
        }
        return matched;
    }

    /** Whether one element satisfies all non-scope, non-disambiguator predicates in the selector. */
    private static boolean matches(Element c, JsonObject selector) {
        if (selector.has("label")) {
            if (!normalize(c.label).equals(normalize(str(selector, "label")))) {
                return false;
            }
        }
        if (selector.has("text")) {
            // Exact visible-text match against label or text.
            String want = normalize(str(selector, "text"));
            if (!normalize(c.text).equals(want) && !normalize(c.label).equals(want)) {
                return false;
            }
        }
        if (selector.has("textContains")) {
            String hay = normalize((c.label == null ? "" : c.label) + "\n" + (c.text == null ? "" : c.text));
            if (!hay.contains(normalize(str(selector, "textContains")))) {
                return false;
            }
        }
        if (selector.has("loreContains")) {
            // `loreContains` is `string | string[]` (PROTOCOL.md §7.3.1); an array ANDs every entry.
            String joined = normalize(String.join("\n", c.lore));
            JsonElement lc = selector.get("loreContains");
            if (lc.isJsonArray()) {
                for (JsonElement entry : lc.getAsJsonArray()) {
                    if (!entry.isJsonPrimitive() || !joined.contains(normalize(entry.getAsString()))) {
                        return false;
                    }
                }
            } else {
                String needle = str(selector, "loreContains");
                // A malformed (non-string, non-array) loreContains matches nothing — never everything.
                if (needle == null || !joined.contains(normalize(needle))) {
                    return false;
                }
            }
        }
        if (selector.has("itemType")) {
            // Minecraft identifier: exact, no text normalization (SELECTORS.md §5/§4.5).
            if (c.itemType == null || !c.itemType.equals(str(selector, "itemType"))) {
                return false;
            }
        }
        if (selector.has("role")) {
            if (c.role == null || !c.role.equals(str(selector, "role"))) {
                return false;
            }
        }
        if (selector.has("testId")) {
            // Exact equality, no normalization (SELECTORS.md §5).
            if (c.testId == null || !c.testId.equals(str(selector, "testId"))) {
                return false;
            }
        }
        return true;
    }

    /**
     * The canonical normalization pipeline (SELECTORS.md §4.1): flatten, strip legacy {@code §}/{@code &}
     * color codes, strip zero-width chars, NFKC, collapse whitespace + trim, lowercase.
     */
    public static String normalize(String s) {
        if (s == null) {
            return "";
        }
        // 2. strip legacy color/format codes (§ or & followed by 0-9a-fk-or).
        String out = s.replaceAll("[§&][0-9A-FK-ORa-fk-or]", "");
        // 3. strip zero-width artifacts.
        out = out.replaceAll("[​‌‍﻿]", "");
        // 4. NFKC unicode normalize.
        out = Normalizer.normalize(out, Normalizer.Form.NFKC);
        // 5. collapse whitespace + trim.
        out = out.replaceAll("\\s+", " ").trim();
        // 6. case fold (locale-independent).
        out = out.toLowerCase(java.util.Locale.ROOT);
        return out;
    }

    private static String str(JsonObject o, String key) {
        JsonElement el = o.get(key);
        return el != null && el.isJsonPrimitive() ? el.getAsString() : null;
    }

    private static Integer readInt(JsonObject o, String key) {
        JsonElement el = o.get(key);
        if (el != null && el.isJsonPrimitive() && el.getAsJsonPrimitive().isNumber()) {
            return el.getAsInt();
        }
        return null;
    }
}
