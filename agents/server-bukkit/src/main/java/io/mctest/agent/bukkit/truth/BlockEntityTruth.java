package io.mctest.agent.bukkit.truth;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.bukkit.block.Block;
import org.bukkit.block.BlockState;
import org.bukkit.block.Container;
import org.bukkit.block.CreatureSpawner;
import org.bukkit.block.Lectern;
import org.bukkit.block.Sign;
import org.bukkit.block.Skull;
import org.bukkit.block.TileState;
import org.bukkit.inventory.Inventory;
import org.bukkit.inventory.ItemStack;
import org.bukkit.persistence.PersistentDataContainer;

/**
 * Reads a block's <b>block-entity</b> data via the Bukkit API and renders it with the vanilla NBT
 * key names, filling the long-declared-but-never-populated {@code block.nbtJson} (PROTOCOL.md §7.3)
 * plus its pre-parsed {@code block.nbt} twin.
 *
 * <p><b>What this is and is not.</b> No Bukkit API exposes a byte-exact vanilla NBT dump, and this
 * agent may not touch NMS (a Prime Directive — it is what keeps the Bukkit agent version-agnostic).
 * So this is an <i>API-derived</i> block-entity document that uses vanilla NBT names wherever the
 * Bukkit API exposes the same value ({@code front_text.messages}, {@code CustomName}, {@code Lock},
 * {@code Items}). A key that is absent means "the agent cannot see it", never "the world does not
 * have it" — which is why {@code getBlock`s `expectNbt`} FAILS rather than passes when there is no
 * block entity at all.
 *
 * <p>Every branch is defensive: a Bukkit API shape that does not exist on an older server (the
 * sign {@code Side}/{@code SignSide} pair arrived in 1.20) raises a linkage error on first use, and
 * the fallback path keeps the older servers in the matrix working instead of failing the read.
 */
public final class BlockEntityTruth {

    private BlockEntityTruth() {
    }

    /**
     * @return the block-entity document, or {@code null} when this block has no block entity (which
     *     is the honest answer for stone, air, or any plain block).
     */
    public static JsonObject read(Block block) {
        BlockState state;
        try {
            state = block.getState();
        } catch (RuntimeException e) {
            return null;
        }
        JsonObject nbt = new JsonObject();

        if (state instanceof Sign) {
            readSign((Sign) state, nbt);
        }
        if (state instanceof Container) {
            readContainer((Container) state, nbt);
        }
        if (state instanceof CreatureSpawner) {
            readSpawner((CreatureSpawner) state, nbt);
        }
        if (state instanceof Lectern) {
            nbt.addProperty("Page", ((Lectern) state).getPage());
        }
        if (state instanceof Skull) {
            readSkull((Skull) state, nbt);
        }
        if (state instanceof TileState) {
            readPersistentData((TileState) state, nbt);
        } else if (nbt.size() == 0) {
            // Not a block entity at all.
            return null;
        }
        return nbt.size() == 0 ? new JsonObject() : nbt;
    }

    private static void readSign(Sign sign, JsonObject nbt) {
        try {
            nbt.add("front_text", signSide(sign, org.bukkit.block.sign.Side.FRONT));
            nbt.add("back_text", signSide(sign, org.bukkit.block.sign.Side.BACK));
            nbt.addProperty("is_waxed", sign.isWaxed());
        } catch (Throwable pre120) {
            // Servers before 1.20 have no Side/SignSide: fall back to the single-sided API so the
            // older matrix rows still report real sign text rather than nothing.
            JsonObject front = new JsonObject();
            JsonArray messages = new JsonArray();
            try {
                for (String line : sign.getLines()) {
                    messages.add(ItemTruth.stripColors(line));
                }
            } catch (Throwable ignored) {
                // Nothing readable — leave `messages` empty rather than inventing lines.
            }
            front.add("messages", messages);
            nbt.add("front_text", front);
        }
    }

    private static JsonObject signSide(Sign sign, org.bukkit.block.sign.Side side) {
        org.bukkit.block.sign.SignSide signSide = sign.getSide(side);
        JsonObject out = new JsonObject();
        JsonArray messages = new JsonArray();
        for (String line : signSide.getLines()) {
            messages.add(ItemTruth.stripColors(line));
        }
        out.add("messages", messages);
        out.addProperty("has_glowing_text", signSide.isGlowingText());
        if (signSide.getColor() != null) {
            out.addProperty("color", signSide.getColor().name().toLowerCase(java.util.Locale.ROOT));
        }
        return out;
    }

    private static void readContainer(Container container, JsonObject nbt) {
        try {
            if (container.getCustomName() != null) {
                nbt.addProperty("CustomName", container.getCustomName());
            }
        } catch (Throwable ignored) {
            // Older/newer name APIs differ; the container's items are the payload that matters.
        }
        try {
            if (container.isLocked()) {
                nbt.addProperty("Lock", container.getLock());
            }
        } catch (Throwable ignored) {
            // Lock is optional API surface.
        }
        JsonArray items = new JsonArray();
        Inventory inv = container.getInventory();
        for (int slot = 0; slot < inv.getSize(); slot++) {
            ItemStack stack = inv.getItem(slot);
            if (ItemTruth.isEmpty(stack)) {
                continue;
            }
            JsonObject entry = new JsonObject();
            entry.addProperty("Slot", slot);
            entry.addProperty("id", ItemTruth.typeId(stack));
            entry.addProperty("count", stack.getAmount());
            entry.add("components", ItemTruth.components(stack));
            items.add(entry);
        }
        nbt.add("Items", items);
    }

    private static void readSpawner(CreatureSpawner spawner, JsonObject nbt) {
        try {
            if (spawner.getSpawnedType() != null) {
                JsonObject entity = new JsonObject();
                entity.addProperty("id", spawner.getSpawnedType().getKey().toString());
                JsonObject spawnData = new JsonObject();
                spawnData.add("entity", entity);
                nbt.add("SpawnData", spawnData);
            }
        } catch (Throwable ignored) {
            // Spawner APIs shift between versions; skip rather than report a wrong entity id.
        }
    }

    private static void readSkull(Skull skull, JsonObject nbt) {
        try {
            if (skull.getOwningPlayer() != null && skull.getOwningPlayer().getName() != null) {
                JsonObject profile = new JsonObject();
                profile.addProperty("name", skull.getOwningPlayer().getName());
                nbt.add("profile", profile);
            }
        } catch (Throwable ignored) {
            // Profile access can hit the network on some servers; never block a truth read on it.
        }
    }

    /**
     * Plugin persistent data. Deliberately namespaced under an {@code mc-test:} key rather than a
     * vanilla NBT name, because it is NOT vanilla NBT — a reader must be able to tell the two apart.
     */
    private static void readPersistentData(TileState state, JsonObject nbt) {
        try {
            PersistentDataContainer pdc = state.getPersistentDataContainer();
            if (pdc.isEmpty()) {
                return;
            }
            JsonArray keys = new JsonArray();
            pdc.getKeys().stream()
                    .map(Object::toString)
                    .sorted()
                    .forEach(keys::add);
            nbt.add("mc-test:persistentDataKeys", keys);
        } catch (Throwable ignored) {
            // PDC arrived in 1.14; older servers simply report no plugin data.
        }
    }
}
