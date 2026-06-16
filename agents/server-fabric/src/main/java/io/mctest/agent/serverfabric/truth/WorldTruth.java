package io.mctest.agent.serverfabric.truth;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import io.mctest.agent.core.McTestException;
import io.mctest.agent.core.McTestSession;
import io.mctest.agent.serverfabric.Params;
import io.mctest.agent.serverfabric.mappings.Names;
import java.util.List;
import java.util.Map;

/**
 * {@code truth.getWorldBlock} / {@code truth.getEntities} — authoritative server-side block/entity
 * reads (PROTOCOL.md §7.3, cap {@code worldTruth}). Same handler skeleton as the {@code server-bukkit}
 * agent, but every world/entity/block access routes through {@link Names} (the only file allowed
 * Yarn-mapped symbols); the Fabric reads use {@code ServerWorld#getBlockState} and entity iteration.
 * All game access bounces to the server thread via {@link Names#call}.
 */
public final class WorldTruth {

    private final Names names;
    private final int radiusLimit;

    public WorldTruth(Names names, int radiusLimit) {
        this.names = names;
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

        return names.call(() -> {
            Names.BlockInfo block = names.getBlock(worldName, x, y, z);
            if (block == null) {
                throw McTestException.worldNotReady("World not loaded: "
                        + (worldName != null ? worldName : "<default>"));
            }
            JsonObject blockJson = new JsonObject();
            blockJson.addProperty("type", block.type);
            if (block.properties != null && !block.properties.isEmpty()) {
                JsonObject props = new JsonObject();
                for (Map.Entry<String, String> e : block.properties.entrySet()) {
                    props.addProperty(e.getKey(), e.getValue());
                }
                blockJson.add("properties", props);
            }
            if (block.biome != null) {
                blockJson.addProperty("biome", block.biome);
            }

            JsonObject result = new JsonObject();
            result.addProperty("ok", true);
            result.add("block", blockJson);
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

        return names.call(() -> {
            List<Names.EntityInfo> found =
                    names.getEntities(worldName, cx, cy, cz, radius, typeFilter);
            if (found == null) {
                throw McTestException.worldNotReady("World not loaded: "
                        + (worldName != null ? worldName : "<default>"));
            }
            JsonArray entities = new JsonArray();
            for (Names.EntityInfo entity : found) {
                entities.add(describeEntity(entity));
            }

            JsonObject result = new JsonObject();
            result.addProperty("ok", true);
            result.addProperty("count", found.size());
            result.add("entities", entities);
            return result;
        }, timeout);
    }

    // --- helpers (pure JSON shaping over the loader-neutral DTOs) ---

    private static JsonObject describeEntity(Names.EntityInfo entity) {
        JsonObject e = new JsonObject();
        e.addProperty("id", entity.id);
        e.addProperty("uuid", entity.uuid);
        e.addProperty("type", entity.type);
        if (entity.name != null) {
            e.addProperty("name", entity.name);
        }

        JsonObject pos = new JsonObject();
        pos.addProperty("x", entity.x);
        pos.addProperty("y", entity.y);
        pos.addProperty("z", entity.z);
        e.add("position", pos);

        if (entity.tags != null && !entity.tags.isEmpty()) {
            JsonArray tags = new JsonArray();
            for (String tag : entity.tags) {
                tags.add(tag);
            }
            e.add("tags", tags);
        }
        if (entity.customNameRaw != null) {
            e.addProperty("customNameRaw", entity.customNameRaw);
        }
        return e;
    }
}
