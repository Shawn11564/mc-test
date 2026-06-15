package io.mctest.agent.core;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.List;

/**
 * Loader-neutral DTOs for the normalized screen/element model (PROTOCOL.md §7.3). Per-loader shims
 * populate these from real widgets/slots; {@link SelectorMatch} filters them against a selector.
 * Shipped now so M4 client agents reuse the same shapes.
 */
public final class ElementModel {

    private ElementModel() {
    }

    /**
     * One addressable UI element. Carries the data the selector keys match against (PROTOCOL.md §7.3):
     * {@code label}, {@code text}, {@code lore}, {@code itemType}, {@code role}, {@code testId}, plus
     * a {@code children} list to support {@code within} scoping.
     */
    public static final class Element {
        public String elementId;
        public String role;
        public String label;
        /** Untouched display string for reports/screenshots (SELECTORS.md §4.1 "Display vs compare"). */
        public String rawLabel;
        public String text;
        public final List<String> lore = new ArrayList<>();
        public String itemType;
        public String testId;
        public Integer slot;
        public boolean enabled = true;
        public boolean visible = true;
        /** Children for {@code within} scoping (driver-defined containment). */
        public final List<Element> children = new ArrayList<>();

        public Element() {
        }

        public Element(String elementId, String role, String label) {
            this.elementId = elementId;
            this.role = role;
            this.label = label;
            this.rawLabel = label;
        }

        /** Serializes to the wire element shape; only non-null fields are emitted. */
        public JsonObject toJson() {
            JsonObject o = new JsonObject();
            if (elementId != null) {
                o.addProperty("elementId", elementId);
            }
            if (role != null) {
                o.addProperty("role", role);
            }
            if (label != null) {
                o.addProperty("label", label);
            }
            if (text != null) {
                o.addProperty("text", text);
            }
            if (!lore.isEmpty()) {
                JsonArray arr = new JsonArray();
                for (String line : lore) {
                    arr.add(line);
                }
                o.add("lore", arr);
            }
            if (itemType != null) {
                o.addProperty("itemType", itemType);
            }
            if (testId != null) {
                o.addProperty("testId", testId);
            }
            if (slot != null) {
                o.addProperty("slot", slot);
            }
            o.addProperty("enabled", enabled);
            o.addProperty("visible", visible);
            return o;
        }
    }

    /**
     * A snapshot of the active screen/GUI (PROTOCOL.md §7.3 {@code screen.get}). {@code kind} ∈
     * {@code {containerGui, clientScreen, hud, none}}.
     */
    public static final class ScreenSnapshot {
        public String screenId;
        public String kind;
        public String title;
        public String titleRaw;
        public final List<Element> elements = new ArrayList<>();

        public JsonObject toJson() {
            JsonObject o = new JsonObject();
            if (screenId != null) {
                o.addProperty("screenId", screenId);
            }
            if (kind != null) {
                o.addProperty("kind", kind);
            }
            if (title != null) {
                o.addProperty("title", title);
            }
            if (titleRaw != null) {
                o.addProperty("titleRaw", titleRaw);
            }
            JsonArray arr = new JsonArray();
            for (Element e : elements) {
                arr.add(e.toJson());
            }
            o.add("elements", arr);
            return o;
        }
    }
}
