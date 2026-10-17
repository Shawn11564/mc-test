package io.mctest.agent.serverneoforge.mappings;

import com.mojang.logging.LogUtils;
import io.mctest.agent.core.bench.MacroMenu;
import io.mctest.agent.core.bench.MacroSource;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import net.minecraft.ChatFormatting;
import net.minecraft.core.component.DataComponents;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.network.chat.Component;
import net.minecraft.network.protocol.game.ClientboundSetCarriedItemPacket;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.network.Filterable;
import net.minecraft.util.Unit;
import net.minecraft.world.SimpleContainer;
import net.minecraft.world.SimpleMenuProvider;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.inventory.AbstractContainerMenu;
import net.minecraft.world.inventory.ChestMenu;
import net.minecraft.world.inventory.ClickType;
import net.minecraft.world.inventory.MenuType;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.item.component.CustomData;
import net.minecraft.world.item.component.ItemLore;
import net.minecraft.world.item.component.WritableBookContent;
import net.minecraft.world.item.component.WrittenBookContent;
import org.slf4j.Logger;

/**
 * Draws {@link MacroMenu} screens as chest menus and hands the clicks back (docs/MACROS.md §8), and keeps the
 * books a macro is edited in. The icons are never real items: every click is answered by redrawing the menu,
 * so nothing can be taken out of it, and the client's own guess at a click is corrected at once.
 */
final class MacroMenus {

    private static final Logger LOGGER = LogUtils.getLogger();
    /** The custom-data key that marks a macro book. */
    private static final String BOOK_KEY = "mctest_macro_book";

    private MacroMenus() {
    }

    static void open(ServerPlayer player, MacroMenu.Screen screen) {
        player.openMenu(new SimpleMenuProvider((id, inventory, p) -> new Gui(id, inventory, screen),
                Component.literal(screen.title())));
    }

    /** Redraws every open macro menu, so a running macro or a file edited elsewhere shows. */
    static void redraw(MinecraftServer server) {
        for (ServerPlayer p : server.getPlayerList().getPlayers()) {
            if (p.containerMenu instanceof Gui gui) {
                gui.draw();
                gui.broadcastChanges();
            }
        }
    }

    /** One open macro menu: a chest whose slots show the screen's icons. */
    static final class Gui extends ChestMenu {
        private final MacroMenu.Screen screen;
        private final SimpleContainer box;
        /** The first slot of a drag that's under way (a held icon pulled across slots), or -1. */
        private int dragTo = -1;

        Gui(int id, Inventory inventory, MacroMenu.Screen screen) {
            this(id, inventory, screen, new SimpleContainer(screen.rows() * 9));
        }

        private Gui(int id, Inventory inventory, MacroMenu.Screen screen, SimpleContainer box) {
            super(screen.rows() == 3 ? MenuType.GENERIC_9x3 : MenuType.GENERIC_9x6, id, inventory, box, screen.rows());
            this.screen = screen;
            this.box = box;
            draw();
        }

        void draw() {
            for (int i = 0; i < box.getContainerSize(); i++) {
                MacroMenu.Icon icon;
                try {
                    icon = screen.icon(i);
                } catch (RuntimeException e) {
                    LOGGER.warn("[mc-test] Macro menu slot {} failed to draw", i, e);
                    icon = null;
                }
                box.setItem(i, icon == null ? ItemStack.EMPTY : stack(icon));
            }
            MacroMenu.Icon held = screen.carried();
            setCarried(held == null ? ItemStack.EMPTY : stack(held));
        }

        @Override
        public void clicked(int slot, int button, ClickType type, Player player) {
            MacroMenu.Click click = null;
            int at = slot;
            switch (type) {
                case PICKUP -> click = slot == -999 ? MacroMenu.Click.OUTSIDE
                        : button == 1 ? MacroMenu.Click.RIGHT : MacroMenu.Click.LEFT;
                case QUICK_MOVE -> click = MacroMenu.Click.SHIFT;
                case THROW -> click = slot == -999 ? MacroMenu.Click.OUTSIDE : MacroMenu.Click.DROP;
                case QUICK_CRAFT -> {
                    // A held icon pulled across slots: it lands on the first one, like a click there.
                    int stage = AbstractContainerMenu.getQuickcraftHeader(button);
                    if (stage == 0) {
                        dragTo = -1;
                    } else if (stage == 1 && dragTo < 0) {
                        dragTo = slot;
                    } else if (stage == 2 && dragTo >= 0) {
                        click = MacroMenu.Click.LEFT;
                        at = dragTo;
                        dragTo = -1;
                    }
                }
                default -> {
                }
            }
            boolean inMenu = at >= 0 && at < box.getContainerSize();
            if (click != null && (inMenu || click == MacroMenu.Click.OUTSIDE)) {
                try {
                    screen.click(at, click);
                } catch (RuntimeException e) {
                    LOGGER.warn("[mc-test] Macro menu click failed", e);
                }
            }
            draw();
        }

        @Override
        public ItemStack quickMoveStack(Player player, int slot) {
            return ItemStack.EMPTY;
        }

        @Override
        public boolean stillValid(Player player) {
            return true;
        }

        @Override
        public void removed(Player player) {
            screen.closed();
            setCarried(ItemStack.EMPTY); // an icon, not an item: it must not land in the inventory
            super.removed(player);
        }
    }

    static ItemStack stack(MacroMenu.Icon icon) {
        Item item = BuiltInRegistries.ITEM.get(ResourceLocation.parse(icon.item()));
        ItemStack stack = new ItemStack(item == Items.AIR ? Items.PAPER : item);
        stack.set(DataComponents.CUSTOM_NAME, text(icon.name()));
        List<Component> lore = new ArrayList<>();
        for (MacroMenu.Line line : icon.lore()) {
            lore.add(text(line));
        }
        stack.set(DataComponents.LORE, new ItemLore(lore));
        stack.set(DataComponents.HIDE_ADDITIONAL_TOOLTIP, Unit.INSTANCE);
        if (icon.glint()) {
            stack.set(DataComponents.ENCHANTMENT_GLINT_OVERRIDE, true);
        }
        return stack;
    }

    private static Component text(MacroMenu.Line line) {
        ChatFormatting color = ChatFormatting.getByName(line.color());
        return Component.literal(line.text()).withStyle(style -> style.withItalic(false)
                .withColor(color == null ? ChatFormatting.WHITE : color));
    }

    // --- editing a macro in a book ---

    /** Saves a book's pages as the macro: null when saved, else why not (the book stays to fix). */
    interface BookSaver {
        String save(ServerPlayer player, String macro, List<String> pages);
    }

    private static final class Book {
        final String macro;
        final String id;
        List<String> pages;

        Book(String macro, String id, List<String> pages) {
            this.macro = macro;
            this.id = id;
            this.pages = pages;
        }
    }

    private static final Map<UUID, Book> BOOKS = new HashMap<>();

    /**
     * Puts a book holding the macro in the player's hand (an empty hotbar slot): right-click it, edit, press
     * Done, and {@link #pollBooks} saves it.
     *
     * @return null when given, else why not.
     */
    static String giveBook(ServerPlayer player, String macro, String block, String file) {
        dropBook(player);
        Inventory inventory = player.getInventory();
        int slot = inventory.getItem(inventory.selected).isEmpty() ? inventory.selected : -1;
        for (int i = 0; i < Inventory.getSelectionSize() && slot < 0; i++) {
            if (inventory.getItem(i).isEmpty()) {
                slot = i;
            }
        }
        if (slot < 0) {
            return "Empty a hotbar slot for the book first";
        }
        List<String> pages = MacroSource.toBook(block);
        String id = UUID.randomUUID().toString();
        ItemStack book = new ItemStack(Items.WRITABLE_BOOK);
        List<Filterable<String>> content = new ArrayList<>();
        for (String page : pages) {
            content.add(Filterable.passThrough(page));
        }
        book.set(DataComponents.WRITABLE_BOOK_CONTENT, new WritableBookContent(content));
        book.set(DataComponents.CUSTOM_NAME, text(new MacroMenu.Line("Macro " + macro, "aqua")));
        book.set(DataComponents.LORE, new ItemLore(List.of(text(new MacroMenu.Line("Right-click to edit it;", "gray")),
                text(new MacroMenu.Line("Done saves it to " + file + ".", "gray")))));
        CompoundTag tag = new CompoundTag();
        tag.putString(BOOK_KEY, id);
        book.set(DataComponents.CUSTOM_DATA, CustomData.of(tag));
        inventory.setItem(slot, book);
        inventory.selected = slot;
        player.connection.send(new ClientboundSetCarriedItemPacket(slot));
        BOOKS.put(player.getUUID(), new Book(macro, id, pages));
        return null;
    }

    static boolean hasBook(ServerPlayer player) {
        return BOOKS.containsKey(player.getUUID());
    }

    /** Takes the player's macro book away unsaved (cancel, logout). */
    static void dropBook(ServerPlayer player) {
        Book book = BOOKS.remove(player.getUUID());
        if (book == null) {
            return;
        }
        int slot = find(player, book.id);
        if (slot >= 0) {
            player.getInventory().setItem(slot, ItemStack.EMPTY);
        }
    }

    /** Saves each book whose pages changed (the player pressed Done, or signed it). */
    static void pollBooks(MinecraftServer server, BookSaver saver) {
        Iterator<Map.Entry<UUID, Book>> it = BOOKS.entrySet().iterator();
        while (it.hasNext()) {
            Map.Entry<UUID, Book> e = it.next();
            Book book = e.getValue();
            ServerPlayer player = server.getPlayerList().getPlayer(e.getKey());
            if (player == null) {
                it.remove();
                continue;
            }
            int slot = find(player, book.id);
            if (slot < 0) {
                it.remove();
                player.sendSystemMessage(Component.literal("[macro] The book for " + book.macro
                        + " is gone, so nothing was saved").withStyle(ChatFormatting.GRAY));
                continue;
            }
            ItemStack stack = player.getInventory().getItem(slot);
            List<String> pages = new ArrayList<>();
            boolean signed = stack.is(Items.WRITTEN_BOOK);
            if (signed) {
                WrittenBookContent written = stack.get(DataComponents.WRITTEN_BOOK_CONTENT);
                if (written != null) {
                    written.pages().forEach(p -> pages.add(p.raw().getString()));
                }
            } else {
                WritableBookContent writable = stack.get(DataComponents.WRITABLE_BOOK_CONTENT);
                if (writable != null) {
                    writable.pages().forEach(p -> pages.add(p.raw()));
                }
            }
            if (!signed && pages.equals(book.pages)) {
                continue;
            }
            book.pages = pages;
            String why = saver.save(player, book.macro, pages);
            if (why == null) {
                it.remove();
                player.getInventory().setItem(slot, ItemStack.EMPTY);
            } else if (signed) {
                // A signed book can't be edited again; hand back a writable one with the same pages to fix.
                ItemStack again = stack.transmuteCopy(Items.WRITABLE_BOOK, 1);
                again.remove(DataComponents.WRITTEN_BOOK_CONTENT);
                List<Filterable<String>> content = new ArrayList<>();
                pages.forEach(p -> content.add(Filterable.passThrough(p)));
                again.set(DataComponents.WRITABLE_BOOK_CONTENT, new WritableBookContent(content));
                player.getInventory().setItem(slot, again);
            }
        }
    }

    private static int find(ServerPlayer player, String id) {
        Inventory inventory = player.getInventory();
        for (int i = 0; i < inventory.getContainerSize(); i++) {
            CustomData data = inventory.getItem(i).get(DataComponents.CUSTOM_DATA);
            if (data != null && id.equals(data.copyTag().getString(BOOK_KEY))) {
                return i;
            }
        }
        return -1;
    }
}
