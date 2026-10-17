package io.mctest.agent.serverfabric.mappings;

import com.mojang.logging.LogUtils;
import io.mctest.agent.core.bench.MacroMenu;
import io.mctest.agent.core.bench.MacroSource;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import net.minecraft.component.DataComponentTypes;
import net.minecraft.registry.Registries;
import net.minecraft.nbt.NbtCompound;
import net.minecraft.text.Text;
import net.minecraft.util.Formatting;
import net.minecraft.network.packet.s2c.play.UpdateSelectedSlotS2CPacket;
import net.minecraft.util.Identifier;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.text.RawFilteredPair;
import net.minecraft.util.Unit;
import net.minecraft.inventory.SimpleInventory;
import net.minecraft.screen.SimpleNamedScreenHandlerFactory;
import net.minecraft.entity.player.PlayerInventory;
import net.minecraft.entity.player.PlayerEntity;
import net.minecraft.screen.ScreenHandler;
import net.minecraft.screen.GenericContainerScreenHandler;
import net.minecraft.screen.slot.SlotActionType;
import net.minecraft.screen.ScreenHandlerType;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.item.Items;
import net.minecraft.component.type.NbtComponent;
import net.minecraft.component.type.LoreComponent;
import net.minecraft.component.type.WritableBookContentComponent;
import net.minecraft.component.type.WrittenBookContentComponent;
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

    static void open(ServerPlayerEntity player, MacroMenu.Screen screen) {
        player.openHandledScreen(new SimpleNamedScreenHandlerFactory((id, inventory, p) -> new Gui(id, inventory, screen),
                Text.literal(screen.title())));
    }

    /** Redraws every open macro menu, so a running macro or a file edited elsewhere shows. */
    static void redraw(MinecraftServer server) {
        for (ServerPlayerEntity p : server.getPlayerManager().getPlayerList()) {
            if (p.currentScreenHandler instanceof Gui gui) {
                gui.draw();
                gui.sendContentUpdates();
            }
        }
    }

    /** One open macro menu: a chest whose slots show the screen's icons. */
    static final class Gui extends GenericContainerScreenHandler {
        private final MacroMenu.Screen screen;
        private final SimpleInventory box;
        /** The first slot of a drag that's under way (a held icon pulled across slots), or -1. */
        private int dragTo = -1;

        Gui(int id, PlayerInventory inventory, MacroMenu.Screen screen) {
            this(id, inventory, screen, new SimpleInventory(screen.rows() * 9));
        }

        private Gui(int id, PlayerInventory inventory, MacroMenu.Screen screen, SimpleInventory box) {
            super(screen.rows() == 3 ? ScreenHandlerType.GENERIC_9X3 : ScreenHandlerType.GENERIC_9X6, id, inventory, box, screen.rows());
            this.screen = screen;
            this.box = box;
            draw();
        }

        void draw() {
            for (int i = 0; i < box.size(); i++) {
                MacroMenu.Icon icon;
                try {
                    icon = screen.icon(i);
                } catch (RuntimeException e) {
                    LOGGER.warn("[mc-test] Macro menu slot {} failed to draw", i, e);
                    icon = null;
                }
                box.setStack(i, icon == null ? ItemStack.EMPTY : stack(icon));
            }
            MacroMenu.Icon held = screen.carried();
            setCursorStack(held == null ? ItemStack.EMPTY : stack(held));
        }

        @Override
        public void onSlotClick(int slot, int button, SlotActionType type, PlayerEntity player) {
            MacroMenu.Click click = null;
            int at = slot;
            switch (type) {
                case PICKUP -> click = slot == -999 ? MacroMenu.Click.OUTSIDE
                        : button == 1 ? MacroMenu.Click.RIGHT : MacroMenu.Click.LEFT;
                case QUICK_MOVE -> click = MacroMenu.Click.SHIFT;
                case THROW -> click = slot == -999 ? MacroMenu.Click.OUTSIDE : MacroMenu.Click.DROP;
                case QUICK_CRAFT -> {
                    // A held icon pulled across slots: it lands on the first one, like a click there.
                    int stage = ScreenHandler.unpackQuickCraftStage(button);
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
            boolean inMenu = at >= 0 && at < box.size();
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
        public ItemStack quickMove(PlayerEntity player, int slot) {
            return ItemStack.EMPTY;
        }

        @Override
        public boolean canUse(PlayerEntity player) {
            return true;
        }

        @Override
        public void onClosed(PlayerEntity player) {
            screen.closed();
            setCursorStack(ItemStack.EMPTY); // an icon, not an item: it must not land in the inventory
            super.onClosed(player);
        }
    }

    static ItemStack stack(MacroMenu.Icon icon) {
        Item item = Registries.ITEM.get(Identifier.of(icon.item()));
        ItemStack stack = new ItemStack(item == Items.AIR ? Items.PAPER : item);
        stack.set(DataComponentTypes.CUSTOM_NAME, text(icon.name()));
        List<Text> lore = new ArrayList<>();
        for (MacroMenu.Line line : icon.lore()) {
            lore.add(text(line));
        }
        stack.set(DataComponentTypes.LORE, new LoreComponent(lore));
        stack.set(DataComponentTypes.HIDE_ADDITIONAL_TOOLTIP, Unit.INSTANCE);
        if (icon.glint()) {
            stack.set(DataComponentTypes.ENCHANTMENT_GLINT_OVERRIDE, true);
        }
        return stack;
    }

    private static Text text(MacroMenu.Line line) {
        Formatting color = Formatting.byName(line.color());
        return Text.literal(line.text()).styled(style -> style.withItalic(false)
                .withColor(color == null ? Formatting.WHITE : color));
    }

    // --- editing a macro in a book ---

    /** Saves a book's pages as the macro: null when saved, else why not (the book stays to fix). */
    interface BookSaver {
        String save(ServerPlayerEntity player, String macro, List<String> pages);
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
    static String giveBook(ServerPlayerEntity player, String macro, String block, String file) {
        dropBook(player);
        PlayerInventory inventory = player.getInventory();
        int slot = inventory.getStack(inventory.selectedSlot).isEmpty() ? inventory.selectedSlot : -1;
        for (int i = 0; i < PlayerInventory.getHotbarSize() && slot < 0; i++) {
            if (inventory.getStack(i).isEmpty()) {
                slot = i;
            }
        }
        if (slot < 0) {
            return "Empty a hotbar slot for the book first";
        }
        List<String> pages = MacroSource.toBook(block);
        String id = UUID.randomUUID().toString();
        ItemStack book = new ItemStack(Items.WRITABLE_BOOK);
        List<RawFilteredPair<String>> content = new ArrayList<>();
        for (String page : pages) {
            content.add(RawFilteredPair.of(page));
        }
        book.set(DataComponentTypes.WRITABLE_BOOK_CONTENT, new WritableBookContentComponent(content));
        book.set(DataComponentTypes.CUSTOM_NAME, text(new MacroMenu.Line("Macro " + macro, "aqua")));
        book.set(DataComponentTypes.LORE, new LoreComponent(List.of(text(new MacroMenu.Line("Right-click to edit it;", "gray")),
                text(new MacroMenu.Line("Done saves it to " + file + ".", "gray")))));
        NbtCompound tag = new NbtCompound();
        tag.putString(BOOK_KEY, id);
        book.set(DataComponentTypes.CUSTOM_DATA, NbtComponent.of(tag));
        inventory.setStack(slot, book);
        inventory.selectedSlot = slot;
        player.networkHandler.sendPacket(new UpdateSelectedSlotS2CPacket(slot));
        BOOKS.put(player.getUuid(), new Book(macro, id, pages));
        return null;
    }

    static boolean hasBook(ServerPlayerEntity player) {
        return BOOKS.containsKey(player.getUuid());
    }

    /** Takes the player's macro book away unsaved (cancel, logout). */
    static void dropBook(ServerPlayerEntity player) {
        Book book = BOOKS.remove(player.getUuid());
        if (book == null) {
            return;
        }
        int slot = find(player, book.id);
        if (slot >= 0) {
            player.getInventory().setStack(slot, ItemStack.EMPTY);
        }
    }

    /** Saves each book whose pages changed (the player pressed Done, or signed it). */
    static void pollBooks(MinecraftServer server, BookSaver saver) {
        Iterator<Map.Entry<UUID, Book>> it = BOOKS.entrySet().iterator();
        while (it.hasNext()) {
            Map.Entry<UUID, Book> e = it.next();
            Book book = e.getValue();
            ServerPlayerEntity player = server.getPlayerManager().getPlayer(e.getKey());
            if (player == null) {
                it.remove();
                continue;
            }
            int slot = find(player, book.id);
            if (slot < 0) {
                it.remove();
                player.sendMessage(Text.literal("[macro] The book for " + book.macro
                        + " is gone, so nothing was saved").formatted(Formatting.GRAY));
                continue;
            }
            ItemStack stack = player.getInventory().getStack(slot);
            List<String> pages = new ArrayList<>();
            boolean signed = stack.isOf(Items.WRITTEN_BOOK);
            if (signed) {
                WrittenBookContentComponent written = stack.get(DataComponentTypes.WRITTEN_BOOK_CONTENT);
                if (written != null) {
                    written.pages().forEach(p -> pages.add(p.raw().getString()));
                }
            } else {
                WritableBookContentComponent writable = stack.get(DataComponentTypes.WRITABLE_BOOK_CONTENT);
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
                player.getInventory().setStack(slot, ItemStack.EMPTY);
            } else if (signed) {
                // A signed book can't be edited again; hand back a writable one with the same pages to fix.
                ItemStack again = stack.copyComponentsToNewStack(Items.WRITABLE_BOOK, 1);
                again.remove(DataComponentTypes.WRITTEN_BOOK_CONTENT);
                List<RawFilteredPair<String>> content = new ArrayList<>();
                pages.forEach(p -> content.add(RawFilteredPair.of(p)));
                again.set(DataComponentTypes.WRITABLE_BOOK_CONTENT, new WritableBookContentComponent(content));
                player.getInventory().setStack(slot, again);
            }
        }
    }

    private static int find(ServerPlayerEntity player, String id) {
        PlayerInventory inventory = player.getInventory();
        for (int i = 0; i < inventory.size(); i++) {
            NbtComponent data = inventory.getStack(i).get(DataComponentTypes.CUSTOM_DATA);
            if (data != null && id.equals(data.copyNbt().getString(BOOK_KEY))) {
                return i;
            }
        }
        return -1;
    }
}
