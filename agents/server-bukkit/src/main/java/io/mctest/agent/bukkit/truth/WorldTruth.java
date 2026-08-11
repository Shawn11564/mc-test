package io.mctest.agent.bukkit.truth;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import io.mctest.agent.bukkit.MainThread;
import io.mctest.agent.bukkit.Params;
import io.mctest.agent.core.McTestException;
import io.mctest.agent.core.McTestSession;
import java.util.Locale;
import io.mctest.agent.core.Canonical;
import org.bukkit.Bukkit;
import org.bukkit.Location;
import org.bukkit.World;
import org.bukkit.block.Block;
import org.bukkit.block.BlockState;
import org.bukkit.block.Container;
import org.bukkit.entity.Entity;
import org.bukkit.inventory.Inventory;
import org.bukkit.inventory.ItemStack;
import org.bukkit.plugin.Plugin;

/**
 * {@code truth.getWorldBlock} / {@code truth.getEntities} — authoritative server-side block/entity
 * reads (PROTOCOL.md §7.3, cap {@code worldTruth}). Bukkit/Paper API only: blocks come from
 * {@link World#getBlockAt}, entities from {@link World#getNearbyEntities}. All game access bounces to
 * the server thread via {@link MainThread}.
 */
public final class WorldTruth {

    private final Plugin plugin;
    private final int radiusLimit;

    public WorldTruth(Plugin plugin, int radiusLimit) {
        this.plugin = plugin;
        this.radiusLimit = radiusLimit;
    }

    /**
     * {@code truth.getWorldBlock} params {@code { world?, x, y, z }} →
     * {@code { ok, block:{ type, properties?, nbtJson?, biome? } }}. Unknown/unloaded world or
     * out-of-build-range coordinate → {@code -32004 WORLD_NOT_READY}.
     */
    public JsonObject getWorldBlock(McTestSession session, JsonObject params) throws McTestException {
        String worldName = Params.optString(params, "world", null);
        int x = Params.requireInt(params, "x");
        int y = Params.requireInt(params, "y");
        int z = Params.requireInt(params, "z");
        long timeout = Params.timeoutMs(params, 15000);

        return MainThread.call(plugin, () -> {
            World world = resolveWorld(worldName);
            if (world == null) {
                throw McTestException.worldNotReady("World not loaded: "
                        + (worldName != null ? worldName : "<default>"));
            }
            if (y < world.getMinHeight() || y >= world.getMaxHeight()) {
                throw McTestException.worldNotReady("y out of range for world " + world.getName()
                        + ": " + y);
            }
            if (!world.isChunkLoaded(x >> 4, z >> 4)) {
                // Loading would mutate state; treat an unloaded chunk as not-ready (retryable).
                throw McTestException.worldNotReady("Chunk not loaded at " + x + "," + z);
            }

            Block block = world.getBlockAt(x, y, z);
            JsonObject blockJson = new JsonObject();
            // Bukkit Material#getKey is a NamespacedKey -> "minecraft:lowercase".
            blockJson.addProperty("type", materialId(block));
            JsonObject props = blockDataProperties(block);
            if (props.size() > 0) {
                blockJson.add("properties", props);
            }
            blockJson.addProperty("biome",
                    block.getBiome().getKey().toString());
            // Block-entity data (sign text, container contents, plugin PDC keys). ABSENT when the
            // block has no block entity — a reader must be able to tell "no block entity" from
            // "an empty one", which is why this is null-checked rather than defaulted to {}.
            JsonObject nbt = BlockEntityTruth.read(block);
            if (nbt != null) {
                blockJson.add("nbt", nbt);
                blockJson.addProperty("nbtJson", Canonical.json(nbt));
            }

            JsonObject result = new JsonObject();
            result.addProperty("ok", true);
            result.add("block", blockJson);
            return result;
        }, timeout);
    }

    /**
     * {@code truth.getContainer} params {@code { world?, x, y, z, includeEmpty? }} to
     * {@code { ok, container:{ type, title?, size, itemCount, slots:[ItemStack] } }}. A block that
     * is not a container gives {@code -32602 invalidParams} (an empty slot list would read as "the
     * chest is empty", which is a different and false claim).
     */
    public JsonObject getContainer(McTestSession session, JsonObject params) throws McTestException {
        String worldName = Params.optString(params, "world", null);
        int x = Params.requireInt(params, "x");
        int y = Params.requireInt(params, "y");
        int z = Params.requireInt(params, "z");
        boolean includeEmpty = params.has("includeEmpty")
                && params.get("includeEmpty").isJsonPrimitive()
                && params.get("includeEmpty").getAsBoolean();
        long timeout = Params.timeoutMs(params, 15000);

        return MainThread.call(plugin, () -> {
            Block block = requireLoadedBlock(worldName, x, y, z);
            Container container = requireContainer(block, x, y, z);
            Inventory inv = container.getInventory();

            JsonArray slots = new JsonArray();
            int itemCount = 0;
            for (int slot = 0; slot < inv.getSize(); slot++) {
                ItemStack stack = inv.getItem(slot);
                if (ItemTruth.isEmpty(stack)) {
                    if (includeEmpty) {
                        JsonObject empty = new JsonObject();
                        empty.addProperty("type", "minecraft:air");
                        empty.addProperty("count", 0);
                        empty.addProperty("slot", slot);
                        slots.add(empty);
                    }
                    continue;
                }
                slots.add(ItemTruth.describe(stack, slot));
                itemCount++;
            }

            JsonObject containerJson = new JsonObject();
            containerJson.addProperty("type", materialId(block));
            String title = containerTitle(container);
            if (title != null) {
                containerJson.addProperty("title", title);
            }
            containerJson.addProperty("size", inv.getSize());
            containerJson.addProperty("itemCount", itemCount);
            containerJson.add("slots", slots);

            JsonObject result = new JsonObject();
            result.addProperty("ok", true);
            result.add("container", containerJson);
            return result;
        }, timeout);
    }

    /**
     * {@code truth.getItem} params {@code { world?, x, y, z, slot }} to
     * {@code { ok, slot, item: ItemStack|null }}. An empty slot is an explicit {@code null} (never
     * an omitted field); a slot outside the inventory gives {@code -32602 invalidParams}.
     */
    public JsonObject getItem(McTestSession session, JsonObject params) throws McTestException {
        String worldName = Params.optString(params, "world", null);
        int x = Params.requireInt(params, "x");
        int y = Params.requireInt(params, "y");
        int z = Params.requireInt(params, "z");
        int slot = Params.requireInt(params, "slot");
        long timeout = Params.timeoutMs(params, 15000);

        return MainThread.call(plugin, () -> {
            Block block = requireLoadedBlock(worldName, x, y, z);
            Container container = requireContainer(block, x, y, z);
            Inventory inv = container.getInventory();
            if (slot < 0 || slot >= inv.getSize()) {
                throw McTestException.invalidParams("slot " + slot + " out of range for a "
                        + inv.getSize() + "-slot inventory");
            }
            ItemStack stack = inv.getItem(slot);

            JsonObject result = new JsonObject();
            result.addProperty("ok", true);
            result.addProperty("slot", slot);
            if (ItemTruth.isEmpty(stack)) {
                result.add("item", com.google.gson.JsonNull.INSTANCE);
            } else {
                result.add("item", ItemTruth.describe(stack, slot));
            }
            return result;
        }, timeout);
    }

    /**
     * {@code truth.getEntities} params {@code { world?, center:{x,y,z}, radius, type? }} →
     * {@code { ok, count, entities:[{ id, uuid, type, name?, position, tags?, customNameRaw? }] }}.
     * A {@code radius} above the granted {@code worldTruth.radiusLimit} → {@code -32602 invalidParams}.
     */
    public JsonObject getEntities(McTestSession session, JsonObject params) throws McTestException {
        JsonObject center = Params.optObject(params, "center");
        if (center == null) {
            throw McTestException.invalidParams("Missing required object param: center");
        }
        double cx = Params.optDouble(center, "x", Double.NaN);
        double cy = Params.optDouble(center, "y", Double.NaN);
        double cz = Params.optDouble(center, "z", Double.NaN);
        if (Double.isNaN(cx) || Double.isNaN(cy) || Double.isNaN(cz)) {
            throw McTestException.invalidParams("center requires numeric x, y, z");
        }
        double radius = Params.optDouble(params, "radius", Double.NaN);
        if (Double.isNaN(radius) || radius < 0) {
            throw McTestException.invalidParams("Missing required numeric param: radius");
        }
        if (radius > radiusLimit) {
            throw McTestException.invalidParams("radius " + radius
                    + " exceeds worldTruth.radiusLimit " + radiusLimit);
        }
        String worldName = Params.optString(params, "world", null);
        String typeFilter = Params.optString(params, "type", null);
        long timeout = Params.timeoutMs(params, 15000);

        return MainThread.call(plugin, () -> {
            World world = resolveWorld(worldName);
            if (world == null) {
                throw McTestException.worldNotReady("World not loaded: "
                        + (worldName != null ? worldName : "<default>"));
            }
            Location centerLoc = new Location(world, cx, cy, cz);
            JsonArray entities = new JsonArray();
            int count = 0;
            for (Entity entity : world.getNearbyEntities(centerLoc, radius, radius, radius)) {
                // Spherical filter (getNearbyEntities is a box).
                if (entity.getLocation().distanceSquared(centerLoc) > radius * radius) {
                    continue;
                }
                String type = entity.getType().getKey().toString();
                if (typeFilter != null && !typeFilter.equals(type)) {
                    continue;
                }
                entities.add(describeEntity(entity, type));
                count++;
            }

            JsonObject result = new JsonObject();
            result.addProperty("ok", true);
            result.addProperty("count", count);
            result.add("entities", entities);
            return result;
        }, timeout);
    }

    // --- helpers (called only on the server thread) ---

    /** Resolves + range/loaded-checks a block, raising the same WORLD_NOT_READY errors as getWorldBlock. */
    private Block requireLoadedBlock(String worldName, int x, int y, int z) throws McTestException {
        World world = resolveWorld(worldName);
        if (world == null) {
            throw McTestException.worldNotReady("World not loaded: "
                    + (worldName != null ? worldName : "<default>"));
        }
        if (y < world.getMinHeight() || y >= world.getMaxHeight()) {
            throw McTestException.worldNotReady("y out of range for world " + world.getName() + ": " + y);
        }
        if (!world.isChunkLoaded(x >> 4, z >> 4)) {
            throw McTestException.worldNotReady("Chunk not loaded at " + x + "," + z);
        }
        return world.getBlockAt(x, y, z);
    }

    /** The block's container state, or {@code -32602} naming what is actually there. */
    private static Container requireContainer(Block block, int x, int y, int z) throws McTestException {
        BlockState state = block.getState();
        if (!(state instanceof Container)) {
            throw McTestException.invalidParams("Block at " + x + "," + y + "," + z + " is "
                    + materialId(block) + ", not a container");
        }
        return (Container) state;
    }

    private static String containerTitle(Container container) {
        try {
            return container.getCustomName();
        } catch (Throwable ignored) {
            // Name APIs differ across versions; an unreadable title is simply absent.
            return null;
        }
    }

    private World resolveWorld(String worldName) {
        if (worldName != null && !worldName.isEmpty()) {
            return Bukkit.getWorld(worldName);
        }
        // Default to the primary (first) loaded world, mirroring "the player's current world".
        return Bukkit.getWorlds().isEmpty() ? null : Bukkit.getWorlds().get(0);
    }

    private static String materialId(Block block) {
        // NamespacedKey.toString() already yields "minecraft:oak_sign" lowercase.
        return block.getType().getKey().toString().toLowerCase(Locale.ROOT);
    }

    /**
     * Extracts blockstate properties from the {@code BlockData} string form (e.g.
     * {@code minecraft:oak_sign[rotation=8]}) without touching NMS. Returns an empty object when the
     * block has no properties.
     */
    private static JsonObject blockDataProperties(Block block) {
        JsonObject props = new JsonObject();
        String data = block.getBlockData().getAsString();
        int open = data.indexOf('[');
        int close = data.lastIndexOf(']');
        if (open >= 0 && close > open) {
            String inner = data.substring(open + 1, close);
            for (String pair : inner.split(",")) {
                int eq = pair.indexOf('=');
                if (eq > 0) {
                    props.addProperty(pair.substring(0, eq).trim(), pair.substring(eq + 1).trim());
                }
            }
        }
        return props;
    }

    private static JsonObject describeEntity(Entity entity, String type) {
        JsonObject e = new JsonObject();
        // 64-bit entity id transmitted as a string (PROTOCOL.md §2.2).
        e.addProperty("id", "e_" + entity.getEntityId());
        e.addProperty("uuid", entity.getUniqueId().toString());
        e.addProperty("type", type);
        if (entity.getName() != null) {
            e.addProperty("name", entity.getName());
        }

        Location loc = entity.getLocation();
        JsonObject pos = new JsonObject();
        pos.addProperty("x", loc.getX());
        pos.addProperty("y", loc.getY());
        pos.addProperty("z", loc.getZ());
        e.add("position", pos);

        if (!entity.getScoreboardTags().isEmpty()) {
            JsonArray tags = new JsonArray();
            for (String tag : entity.getScoreboardTags()) {
                tags.add(tag);
            }
            e.add("tags", tags);
        }
        if (entity.getCustomName() != null) {
            // Plain custom name; rawJson is not reconstructed without NMS (acceptable for §7.3).
            e.addProperty("customNameRaw", entity.getCustomName());
        }
        return e;
    }
}
