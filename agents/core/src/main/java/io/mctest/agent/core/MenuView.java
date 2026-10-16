package io.mctest.agent.core;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * A loader-neutral snapshot of the menu (container screen) a fake player currently has open —
 * what {@code player.menu} returns and what {@code clickMenuText} searches.
 *
 * <p>This type exists so each agent's mappings-quarantined {@code Names.java} can hand back menu
 * contents without a game type crossing the quarantine (the same discipline the inventory snapshot
 * follows). Text is already flattened to plain strings here: a server-side {@code Text}/{@code
 * Component} tree, formatting codes and all, is the loader's business, not the protocol's.
 *
 * <p>Only NON-EMPTY slots are listed. {@link #size} is the full slot count of the open handler
 * (container slots plus the player-inventory rows the menu shows), so an empty slot is simply an
 * index the list skips.
 */
public final class MenuView {

    /** One occupied slot of an open menu. */
    public static final class Slot {
        /** Slot index as the click protocol addresses it — what {@code clickMenuSlot} takes. */
        public final int index;
        /** Item id, e.g. {@code minecraft:player_head}. */
        public final String item;
        public final int count;
        /** Display name as plain text (custom names included — this is what the GUI shows). */
        public final String name;
        /** Lore lines as plain text; empty when the item has none. */
        public final List<String> lore;
        /** The slot belongs to the player's own inventory rather than the container on top. */
        public final boolean playerInventory;

        public Slot(int index, String item, int count, String name, List<String> lore,
                boolean playerInventory) {
            this.index = index;
            this.item = item == null ? "" : item;
            this.count = count;
            this.name = name == null ? "" : name;
            this.lore = lore == null ? Collections.emptyList() : Collections.unmodifiableList(new ArrayList<>(lore));
            this.playerInventory = playerInventory;
        }
    }

    /** No menu open: the player is looking at the world (or at its own inventory). */
    public static final MenuView CLOSED = new MenuView(false, null, null, 0, Collections.emptyList());

    public final boolean open;
    /** Menu type — a registry id when the runtime has one, else the handler's class name. Nullable. */
    public final String type;
    /** Menu title. Only agents whose runtime keeps it (bukkit) can fill this in; nullable elsewhere. */
    public final String title;
    /** Total slot count of the open handler, including the player-inventory rows it shows. */
    public final int size;
    /** Occupied slots, in slot order. */
    public final List<Slot> slots;

    private MenuView(boolean open, String type, String title, int size, List<Slot> slots) {
        this.open = open;
        this.type = type;
        this.title = title;
        this.size = size;
        this.slots = Collections.unmodifiableList(new ArrayList<>(slots));
    }

    public static MenuView of(String type, String title, int size, List<Slot> slots) {
        return new MenuView(true, type, title, size, slots);
    }
}
