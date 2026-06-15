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
 * OpenRegions — the canonical "regions" SUT for mc-test (M2 headless/chest-menu form).
 *
 * {@code /or} opens a server-driven chest GUI titled "OpenRegions" with a "Regions"
 * button. Clicking it opens a "Regions" list GUI with a "TestRegion" entry. Clicking
 * "TestRegion" prints "Region loaded: TestRegion" to chat AND adds "TestRegion" to the
 * authoritative {@link RegionStore} — so the server-truth assertion
 * ({@code truth.assertPluginState query=regions.exists}) reflects real runtime state, not
 * just chat. Items are stamped with an invisible testId (PDC key mc-test:test_id) so
 * cooperating drivers can select robustly, but the canonical test selects by visible label.
 *
 * <p>When the mc-test server agent ({@code mc-test-agent}) is present, this plugin registers
 * a {@link RegionsStateProvider} and {@link RegionsFixtureProvider} via the Bukkit
 * {@code ServicesManager} so the agent can read/mutate the store over MCTP. Registration is
 * guarded so the plugin still enables in pure-M2 mode (agent absent / SPI classes missing).
 */
public final class OpenRegionsPlugin extends JavaPlugin implements Listener, CommandExecutor {

  static final String ROOT_TITLE = "OpenRegions";
  static final String LIST_TITLE = "Regions";

  private NamespacedKey testIdKey;
  private final RegionStore regions = new RegionStore();

  @Override
  public void onEnable() {
    this.testIdKey = new NamespacedKey("mc-test", "test_id");
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
    inv.setItem(11, button(Material.FILLED_MAP, "TestRegion", "regions:entry:TestRegion"));
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
      // Mutate authoritative state AND notify chat, so server-truth and the chat assertion agree.
      regions.add("TestRegion");
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
