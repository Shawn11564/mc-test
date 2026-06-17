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
import org.bukkit.plugin.ServicePriority;
import org.bukkit.plugin.java.JavaPlugin;

import io.mctest.agent.core.McTestFixtureProvider;
import io.mctest.agent.core.McTestStateProvider;

/**
 * OpenRegions — the canonical "regions" SUT for mc-test (headless/chest-menu form).
 *
 * <p>{@code /or} opens a server-driven chest GUI titled "OpenRegions" with a "Regions" button.
 * Clicking it opens the "Regions" list: one entry per region (seeded with {@code TestRegion},
 * {@code Spawn}, {@code Market}) plus "Create" and "Delete" buttons. Clicking an entry "loads" it
 * (marks it active + prints "Region loaded: &lt;name&gt;"); "Create" adds a region; "Delete" removes
 * the active one. Every action mutates the authoritative {@link RegionStore} AND prints chat, so the
 * server-truth assertions ({@code truth.assertPluginState} query {@code regions.exists}/{@code count}/
 * {@code active}) reflect real runtime state, not just chat. The menu stays open across actions so one
 * test can load → create → delete in sequence. Items carry an invisible testId (PDC key
 * mc-test:test_id) so cooperating drivers can select robustly; the canonical test selects by label.
 *
 * <p>When the mc-test server agent ({@code mc-test-agent}) is present, this plugin registers
 * a {@link RegionsStateProvider} and {@link RegionsFixtureProvider} via the Bukkit
 * {@code ServicesManager} so the agent can read/mutate the store over MCTP. Registration is
 * guarded so the plugin still enables in pure-M2 mode (agent absent / SPI classes missing).
 */
public final class OpenRegionsPlugin extends JavaPlugin implements Listener, CommandExecutor {

  static final String ROOT_TITLE = "OpenRegions";
  static final String LIST_TITLE = "Regions";

  /** Regions present at startup, so the store has substance before any GUI action. */
  static final String[] SEED_REGIONS = {"TestRegion", "Spawn", "Market"};
  /** The region the "Create" button adds (a chest menu can't host a text field — see README). */
  static final String CREATE_REGION = "Sanctuary";

  private NamespacedKey testIdKey;
  private final RegionStore regions = new RegionStore();

  @Override
  public void onEnable() {
    this.testIdKey = new NamespacedKey("mc-test", "test_id");
    for (String seed : SEED_REGIONS) {
      regions.add(seed);
    }
    getServer().getPluginManager().registerEvents(this, this);
    PluginCommand or = getCommand("or");
    if (or != null) {
      or.setExecutor(this);
    }
    registerMcTestProviders();
    getLogger().info("OpenRegions enabled");
  }

  /**
   * Registers the mc-test plugin-state and fixture SPIs with the Bukkit ServicesManager so
   * the server agent can probe/mutate {@link #regions}. The {@code mc-test-agent-core} SPI is
   * a {@code provided} (soft) dependency — at runtime the SPI classes come from the agent
   * plugin via {@code softdepend: [mc-test-agent]}. We catch {@link Throwable} so a missing
   * agent (NoClassDefFoundError) leaves the plugin fully functional in pure-M2 mode.
   */
  private void registerMcTestProviders() {
    try {
      getServer().getServicesManager().register(
          McTestStateProvider.class, new RegionsStateProvider(regions), this, ServicePriority.Normal);
      getServer().getServicesManager().register(
          McTestFixtureProvider.class, new RegionsFixtureProvider(regions), this, ServicePriority.Normal);
      getLogger().info("OpenRegions registered mc-test state + fixture providers");
    } catch (Throwable t) {
      // Agent (and its bundled SPI) not present — fine; this is pure-M2 mode.
      getLogger().info("mc-test agent SPI unavailable; running without server-truth providers");
    }
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
    inv.setItem(4, button(Material.BOOK, "Regions", "regions:root:regions"));
    player.openInventory(inv);
  }

  private void openList(Player player) {
    Inventory inv = Bukkit.createInventory(new Menu(Menu.Kind.LIST), 27, LIST_TITLE);
    renderList(inv);
    player.openInventory(inv);
  }

  /**
   * (Re)draws the list menu from current state: one entry per region (click → load), plus a "Create"
   * button (adds {@value #CREATE_REGION}) and a "Delete" button (removes the active region). Called on
   * open and after every create/delete so the open window reflects the store.
   */
  private void renderList(Inventory inv) {
    inv.clear();
    int slot = 10;
    for (String name : regions.names()) {
      inv.setItem(slot, button(Material.FILLED_MAP, name, "regions:entry:" + name));
      slot += 2;
      if (slot > 16) {
        break; // cap the visible entries to the middle row
      }
    }
    inv.setItem(22, button(Material.EMERALD, "Create", "regions:action:create"));
    inv.setItem(24, button(Material.BARRIER, "Delete", "regions:action:delete"));
  }

  private ItemStack button(Material material, String name, String testId) {
    ItemStack item = new ItemStack(material);
    ItemMeta meta = item.getItemMeta();
    meta.setDisplayName(name);
    meta.getPersistentDataContainer().set(testIdKey, PersistentDataType.STRING, testId);
    item.setItemMeta(meta);
    return item;
  }

  /** Reads the invisible mc-test testId stamped into an item's PDC ({@code null} if absent). */
  private String readTestId(ItemStack item) {
    if (item == null || !item.hasItemMeta()) {
      return null;
    }
    return item.getItemMeta().getPersistentDataContainer().get(testIdKey, PersistentDataType.STRING);
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
    String testId = readTestId(clicked);
    if (menu.kind == Menu.Kind.ROOT && "Regions".equals(name)) {
      openList(player);
      return;
    }
    if (menu.kind != Menu.Kind.LIST) {
      return;
    }
    // The list menu stays OPEN across actions so one test can load → create → delete in sequence.
    Inventory list = event.getInventory();
    if ("regions:action:create".equals(testId)) {
      // The chest form has no text field, so "Create" adds a deterministic region (the mod form types
      // a name). Mutating the store is what makes regions.exists/count real — not the chat line.
      regions.add(CREATE_REGION);
      player.sendMessage("Region created: " + CREATE_REGION);
      renderList(list);
    } else if ("regions:action:delete".equals(testId)) {
      String active = regions.getActive();
      if (active != null) {
        regions.remove(active);
        regions.setActive(null);
        player.sendMessage("Region deleted: " + active);
        renderList(list);
      }
    } else if (testId != null && testId.startsWith("regions:entry:")) {
      // Load: mark active AND notify chat, so server-truth (regions.active) and the chat assertion
      // agree — the basis of the truth/UI-divergence negative control.
      regions.setActive(name);
      player.sendMessage("Region loaded: " + name);
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
