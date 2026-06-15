package io.mctest.agent.bukkit.gui;

import org.bukkit.entity.HumanEntity;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.inventory.InventoryOpenEvent;
import org.bukkit.inventory.Inventory;

/**
 * A tiny, optional listener that records the last server-side inventory opened per player. The
 * server agent advertises no client-screen capabilities (UI lives behind the headless/client driver),
 * but recording the last-opened container lets server-side cross-checks correlate a GUI action with a
 * truth read without any MCTP method of its own. Kept minimal on purpose.
 */
public final class ServerGuiBridge implements Listener {

    /** Plain record of the most recent server-side inventory open. */
    public static final class OpenedInventory {
        public final String player;
        public final String title;
        public final int size;
        public final long tsMs;

        OpenedInventory(String player, String title, int size, long tsMs) {
            this.player = player;
            this.title = title;
            this.size = size;
            this.tsMs = tsMs;
        }
    }

    private volatile OpenedInventory lastOpened;

    /** @return the last inventory opened on the server, or {@code null} if none yet. */
    public OpenedInventory lastOpened() {
        return lastOpened;
    }

    @EventHandler
    public void onInventoryOpen(InventoryOpenEvent event) {
        HumanEntity who = event.getPlayer();
        Inventory inv = event.getInventory();
        String title = event.getView() != null ? event.getView().getTitle() : null;
        lastOpened = new OpenedInventory(who.getName(), title, inv.getSize(), System.currentTimeMillis());
    }
}
