package io.mctest.agent.core;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import org.junit.jupiter.api.Test;

/** Menu text matching (spec/42 "click text") — the addressing that makes a modded GUI clickable. */
class MenusTest {

    private static MenuView.Slot slot(int index, String name, String... lore) {
        return new MenuView.Slot(index, "minecraft:player_head", 1, name, Arrays.asList(lore), false);
    }

    private static MenuView menu(MenuView.Slot... slots) {
        return MenuView.of("minecraft:generic_9x6", "Steal Menu", 90, Arrays.asList(slots));
    }

    @Test
    void findsBySubstringOfTheDisplayName() {
        MenuView view = menu(slot(0, "Cancel"), slot(4, "Steal from Rival"));
        assertEquals(Collections.singletonList(4), Menus.find(view, "steal from", false, true));
    }

    @Test
    void ignoresColorCodesCaseAndSpacing() {
        MenuView view = menu(slot(2, "§6§lSTEAL   FROM §fRival"));
        assertEquals(Collections.singletonList(2), Menus.find(view, "steal from rival", false, true));
    }

    @Test
    void exactMatchesTheWholeNameOnly() {
        MenuView view = menu(slot(0, "Steal"), slot(1, "Steal from Rival"));
        assertEquals(Collections.singletonList(0), Menus.find(view, "steal", true, true));
        assertEquals(Arrays.asList(0, 1), Menus.find(view, "steal", false, true));
    }

    @Test
    void nameHitsRankAheadOfLoreHitsInEarlierSlots() {
        // A GUI's own label is on the item name; a lore mention is a description of it.
        MenuView view = menu(
                slot(0, "Confirm", "Steals the selected item"),
                slot(7, "Steal"));
        assertEquals(Arrays.asList(7, 0), Menus.find(view, "steal", false, true));
    }

    @Test
    void loreCanBeExcluded() {
        MenuView view = menu(slot(0, "Confirm", "Steals the selected item"));
        assertTrue(Menus.find(view, "steal", false, false).isEmpty());
        assertEquals(Collections.singletonList(0), Menus.find(view, "steal", false, true));
    }

    @Test
    void aClosedMenuAndAnEmptyNeedleMatchNothing() {
        assertTrue(Menus.find(MenuView.CLOSED, "steal", false, true).isEmpty());
        assertTrue(Menus.find(menu(slot(0, "Steal")), "   ", false, true).isEmpty());
        assertTrue(Menus.find(menu(slot(0, "Steal")), null, false, true).isEmpty());
    }

    @Test
    void clickModesAcceptTheSpellingsCallersUse() throws Exception {
        assertEquals("PICKUP", Menus.clickMode(null));
        assertEquals("PICKUP", Menus.clickMode(""));
        assertEquals("QUICK_MOVE", Menus.clickMode("shift"));
        assertEquals("QUICK_MOVE", Menus.clickMode("quickMove"));
        assertEquals("QUICK_MOVE", Menus.clickMode("quick_move"));
        assertEquals("THROW", Menus.clickMode("drop"));
        assertEquals("PICKUP_ALL", Menus.clickMode("pickupAll"));
        McTestException e = assertThrows(McTestException.class, () -> Menus.clickMode("wiggle"));
        assertTrue(e.getMessage().contains("quickMove"), e.getMessage());
    }

    @Test
    void describeNamesWhatIsActuallyThereAndStopsCounting() {
        assertEquals("no menu open", Menus.describe(MenuView.CLOSED));
        assertEquals("[0] Cancel, [4] Steal from Rival",
                Menus.describe(menu(slot(0, "Cancel"), slot(4, "Steal from Rival"))));

        MenuView.Slot[] many = new MenuView.Slot[20];
        for (int i = 0; i < many.length; i++) {
            many[i] = slot(i, "Item " + i);
        }
        assertTrue(Menus.describe(menu(many)).endsWith("…+8 more"), Menus.describe(menu(many)));
    }

    @Test
    void aMissOrATieRaisesTheProtocolsOwnSelectorErrors() {
        MenuView view = menu(slot(4, "Steal from Rival"), slot(13, "Steal all"));

        McTestException miss = Menus.notFound("trade", view);
        assertEquals(Errors.ELEMENT_NOT_FOUND, miss.code);
        assertTrue(miss.getMessage().contains("[4] Steal from Rival"), miss.getMessage());

        McTestException tie = Menus.ambiguous("steal", Arrays.asList(4, 13), view);
        assertEquals(Errors.AMBIGUOUS_SELECTOR, tie.code);
        assertTrue(tie.getMessage().contains("[13] Steal all"), tie.getMessage());
        assertTrue(tie.getMessage().contains("index"), tie.getMessage());
    }

    @Test
    void jsonCarriesTheSlotRowsAndOmitsEmptyLore() {
        JsonObject json = Menus.json(menu(slot(4, "Steal from Rival", "Costs 1 token"), slot(5, "Cancel")));
        assertTrue(json.get("open").getAsBoolean());
        assertEquals("Steal Menu", json.get("title").getAsString());
        assertEquals(90, json.get("size").getAsInt());
        List<com.google.gson.JsonElement> slots = json.getAsJsonArray("slots").asList();
        assertEquals(2, slots.size());
        JsonObject first = slots.get(0).getAsJsonObject();
        assertEquals(4, first.get("slot").getAsInt());
        assertEquals("Costs 1 token", first.getAsJsonArray("lore").get(0).getAsString());
        assertFalse(slots.get(1).getAsJsonObject().has("lore"));

        JsonObject closed = Menus.json(MenuView.CLOSED);
        assertFalse(closed.get("open").getAsBoolean());
        assertFalse(closed.has("slots"));
    }
}
