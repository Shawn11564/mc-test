package io.mctest.agent.core;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Menu text matching and JSON shaping, shared by every server agent (spec/42 §4 "click text").
 *
 * <p>Clicking a modded GUI by slot index only works when you already know the layout, which for a
 * PokeSteal steal menu or a Cobblemon screen means counting squares in a screenshot. Clicking it by
 * the text the GUI actually shows — the item's display name, or a lore line under it — is how a
 * human describes the same action, so that is the addressing this offers.
 *
 * <p>Text is compared through {@link SelectorMatch#normalize} — the ONE normalization pipeline this
 * project has (SELECTORS.md §4.1: strip {@code §}/{@code &} codes and zero-width junk, NFKC,
 * collapse whitespace, case-fold). The client agent's GUI selectors match this way, so
 * "click the thing that says X" means the same thing on both sides of the protocol.
 */
public final class Menus {

    /** How many slots an error message lists before it starts counting instead. */
    private static final int DESCRIBE_LIMIT = 12;

    /**
     * Click modes, keyed by every spelling a caller might reasonably send, mapped to the vanilla
     * enum constant name. Each agent's mappings shim turns that name into its own mapped constant —
     * never by {@code valueOf}, because enum constant names are themselves remapped at runtime.
     */
    private static final Map<String, String> MODES = new LinkedHashMap<>();

    static {
        // "right" is a BUTTON, not a click type — but a human types it as one, so it resolves to
        // the plain pickup click type and {@link #button} turns it into the right mouse button.
        for (String alias : new String[] {"pickup", "left", "click", "right", "rclick"}) {
            MODES.put(alias, "PICKUP");
        }
        for (String alias : new String[] {"quickmove", "quick_move", "shift", "shiftclick", "shift_click"}) {
            MODES.put(alias, "QUICK_MOVE");
        }
        MODES.put("swap", "SWAP");
        for (String alias : new String[] {"clone", "middle"}) {
            MODES.put(alias, "CLONE");
        }
        for (String alias : new String[] {"throw", "drop"}) {
            MODES.put(alias, "THROW");
        }
        for (String alias : new String[] {"pickupall", "pickup_all", "double"}) {
            MODES.put(alias, "PICKUP_ALL");
        }
    }

    private Menus() {
    }

    /**
     * @param mode caller-supplied mode name (null/empty = a plain left click)
     * @return the vanilla click-type constant name
     * @throws McTestException {@code -32602} naming the accepted modes
     */
    public static String clickMode(String mode) throws McTestException {
        if (mode == null || mode.trim().isEmpty()) {
            return "PICKUP";
        }
        String key = mode.trim().toLowerCase(Locale.ROOT).replace(" ", "");
        String resolved = MODES.get(key);
        if (resolved == null) {
            throw McTestException.invalidParams("Unknown click mode: " + mode
                    + " (supported: pickup, quickMove, swap, clone, throw, pickupAll)");
        }
        return resolved;
    }

    /**
     * The mouse button a mode name implies: right-click spellings mean button 1, everything else
     * leaves the caller's default (an explicit {@code button} param always wins over this).
     */
    public static int button(String mode, int fallback) {
        String key = mode == null ? "" : mode.trim().toLowerCase(Locale.ROOT).replace(" ", "");
        return key.equals("right") || key.equals("rclick") ? 1 : fallback;
    }

    /**
     * Slots whose text matches, in click order: every display-name hit first, then every lore hit.
     * A GUI's own label is on the item name far more often than in its lore, so a name hit is always
     * the more likely intent and must not be shadowed by a lore hit in an earlier slot.
     *
     * @param exact whole normalized string equality instead of "contains"
     * @param lore  also search lore lines (a name-only search is how you exclude a description that
     *              happens to mention the same word)
     */
    public static List<Integer> find(MenuView view, String text, boolean exact, boolean lore) {
        List<Integer> byName = new ArrayList<>();
        List<Integer> byLore = new ArrayList<>();
        if (view == null || !view.open || text == null) {
            return byName;
        }
        String needle = SelectorMatch.normalize(text);
        if (needle.isEmpty()) {
            return byName;
        }
        for (MenuView.Slot slot : view.slots) {
            if (hit(slot.name, needle, exact)) {
                byName.add(slot.index);
                continue;
            }
            if (!lore) {
                continue;
            }
            for (String line : slot.lore) {
                if (hit(line, needle, exact)) {
                    byLore.add(slot.index);
                    break;
                }
            }
        }
        byName.addAll(byLore);
        return byName;
    }

    private static boolean hit(String haystack, String normalizedNeedle, boolean exact) {
        String hay = SelectorMatch.normalize(haystack);
        return exact ? hay.equals(normalizedNeedle) : hay.contains(normalizedNeedle);
    }

    /** The listed slot at this index, or null when the slot is empty (or the menu is closed). */
    public static MenuView.Slot slot(MenuView view, int index) {
        if (view == null) {
            return null;
        }
        for (MenuView.Slot slot : view.slots) {
            if (slot.index == index) {
                return slot;
            }
        }
        return null;
    }

    /** A slot's display name, falling back to its item id for a vanilla-named item. */
    public static String label(MenuView.Slot slot) {
        if (slot == null) {
            return "empty";
        }
        return slot.name.isEmpty() ? slot.item : slot.name;
    }

    /**
     * What the open menu actually holds, for the "no slot matched" error — the one message that turns
     * a failed click into a fixed click without a screenshot.
     */
    public static String describe(MenuView view) {
        if (view == null || !view.open) {
            return "no menu open";
        }
        if (view.slots.isEmpty()) {
            return "the open menu is empty";
        }
        StringBuilder out = new StringBuilder();
        int shown = 0;
        for (MenuView.Slot slot : view.slots) {
            if (shown == DESCRIBE_LIMIT) {
                out.append(", …+").append(view.slots.size() - shown).append(" more");
                break;
            }
            if (shown > 0) {
                out.append(", ");
            }
            out.append('[').append(slot.index).append("] ").append(label(slot));
            shown++;
        }
        return out.toString();
    }

    /**
     * Nothing in the open menu says that. Carries the protocol's own {@code ELEMENT_NOT_FOUND} — a
     * menu slot addressed by its text IS an element matched by a selector — and puts what the menu
     * does say in both the message and {@code data.details}.
     */
    public static McTestException notFound(String text, MenuView view) {
        JsonObject details = new JsonObject();
        details.addProperty("text", text);
        details.addProperty("menu", describe(view));
        JsonObject data = new JsonObject();
        data.add("details", details);
        return new McTestException(Errors.ELEMENT_NOT_FOUND, Errors.REASON_ELEMENT_NOT_FOUND,
                "No menu slot matching \"" + text + "\" — the open menu has: " + describe(view), data);
    }

    /**
     * More than one slot says that and the caller did not say which. Clicking the wrong entry of a
     * steal menu is a real action with real consequences, so this asks instead of guessing —
     * the same rule the client agent's GUI selectors follow.
     */
    public static McTestException ambiguous(String text, List<Integer> hits, MenuView view) {
        StringBuilder which = new StringBuilder();
        JsonArray matches = new JsonArray();
        for (int i = 0; i < hits.size(); i++) {
            int index = hits.get(i);
            matches.add(index);
            if (i > 0) {
                which.append(", ");
            }
            which.append('[').append(index).append("] ").append(label(slot(view, index)));
        }
        JsonObject details = new JsonObject();
        details.addProperty("text", text);
        details.add("matches", matches);
        JsonObject data = new JsonObject();
        data.add("details", details);
        return new McTestException(Errors.AMBIGUOUS_SELECTOR, Errors.REASON_AMBIGUOUS_SELECTOR,
                "\"" + text + "\" matches " + hits.size() + " slots: " + which
                        + " — pass index (0-based) to pick one",
                data);
    }

    /** {@code player.menu} result body (the {@code ok}/{@code name} envelope is the caller's). */
    public static JsonObject json(MenuView view) {
        JsonObject out = new JsonObject();
        out.addProperty("open", view != null && view.open);
        if (view == null || !view.open) {
            return out;
        }
        if (view.type != null) {
            out.addProperty("type", view.type);
        }
        if (view.title != null) {
            out.addProperty("title", view.title);
        }
        out.addProperty("size", view.size);
        JsonArray slots = new JsonArray();
        for (MenuView.Slot slot : view.slots) {
            JsonObject row = new JsonObject();
            row.addProperty("slot", slot.index);
            row.addProperty("item", slot.item);
            row.addProperty("count", slot.count);
            row.addProperty("name", slot.name);
            if (!slot.lore.isEmpty()) {
                JsonArray lore = new JsonArray();
                for (String line : slot.lore) {
                    lore.add(line);
                }
                row.add("lore", lore);
            }
            if (slot.playerInventory) {
                row.addProperty("playerInventory", true);
            }
            slots.add(row);
        }
        out.add("slots", slots);
        return out;
    }
}
