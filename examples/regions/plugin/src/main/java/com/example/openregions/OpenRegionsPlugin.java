package com.example.openregions;

import org.bukkit.Bukkit;
import org.bukkit.Material;
import org.bukkit.NamespacedKey;
import org.bukkit.command.Command;
import org.bukkit.command.CommandExecutor;
import org.bukkit.command.CommandSender;
import org.bukkit.command.PluginCommand;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.inventory.InventoryClickEvent;
import org.bukkit.inventory.Inventory;
import org.bukkit.inventory.InventoryHolder;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.meta.ItemMeta;
import org.bukkit.persistence.PersistentDataType;
import org.bukkit.plugin.java.JavaPlugin;

/**
 * OpenRegions — the canonical "regions" SUT for mc-test (M2 headless/chest-menu form).
 *
 * {@code /or} opens a server-driven chest GUI titled "OpenRegions" with a "Regions"
 * button. Clicking it opens a "Regions" list GUI with a "TestRegion" entry. Clicking
 * "TestRegion" prints "Region loaded: TestRegion" to chat. Items are stamped with an
 * invisible testId (PDC key mc-test:test_id) so cooperating drivers can select robustly,
 * but the canonical test selects by visible label.
 */
public final class OpenRegionsPlugin extends JavaPlugin implements Listener, CommandExecutor {

  static final String ROOT_TITLE = "OpenRegions";
  static final String LIST_TITLE = "Regions";

  private NamespacedKey testIdKey;

  @Override
  public void onEnable() {
    this.testIdKey = new NamespacedKey("mc-test", "test_id");
    getServer().getPluginManager().registerEvents(this, this);
    PluginCommand or = getCommand("or");
    if (or != null) {
      or.setExecutor(this);
    }
    getLogger().info("OpenRegions enabled");
  }

  @Override
  public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
    if (!(sender instanceof Player player)) {
      sender.sendMessage("OpenRegions: players only");
      return true;
    }
    openRoot(player);
    return true;
  }

  private void openRoot(Player player) {
    Inventory inv = Bukkit.createInventory(new Menu(Menu.Kind.ROOT), 9, ROOT_TITLE);
    inv.setItem(4, button(Material.BOOK, "Regions", "regions.btn.list"));
    player.openInventory(inv);
  }

  private void openList(Player player) {
    Inventory inv = Bukkit.createInventory(new Menu(Menu.Kind.LIST), 27, LIST_TITLE);
    inv.setItem(11, button(Material.FILLED_MAP, "TestRegion", "regions.entry.TestRegion"));
    player.openInventory(inv);
  }

  private ItemStack button(Material material, String name, String testId) {
    ItemStack item = new ItemStack(material);
    ItemMeta meta = item.getItemMeta();
    meta.setDisplayName(name);
    meta.getPersistentDataContainer().set(testIdKey, PersistentDataType.STRING, testId);
    item.setItemMeta(meta);
    return item;
  }

  @EventHandler
  public void onClick(InventoryClickEvent event) {
    if (!(event.getInventory().getHolder() instanceof Menu menu)) {
      return;
    }
    // Our GUIs are read-only: cancel every interaction so nothing is moved/taken.
    event.setCancelled(true);
    // Only act on clicks in the top (menu) inventory, not the player's own inventory.
    if (event.getRawSlot() < 0 || event.getRawSlot() >= event.getInventory().getSize()) {
      return;
    }
    if (!(event.getWhoClicked() instanceof Player player)) {
      return;
    }
    ItemStack clicked = event.getCurrentItem();
    if (clicked == null || !clicked.hasItemMeta()) {
      return;
    }
    String name = clicked.getItemMeta().getDisplayName();
    if (menu.kind == Menu.Kind.ROOT && "Regions".equals(name)) {
      openList(player);
    } else if (menu.kind == Menu.Kind.LIST && "TestRegion".equals(name)) {
      player.closeInventory();
      player.sendMessage("Region loaded: TestRegion");
    }
  }

  /** Marker holder distinguishing our two menus from any other open inventory. */
  static final class Menu implements InventoryHolder {
    enum Kind {
      ROOT,
      LIST
    }

    final Kind kind;

    Menu(Kind kind) {
      this.kind = kind;
    }

    @Override
    public Inventory getInventory() {
      return null;
    }
  }
}
