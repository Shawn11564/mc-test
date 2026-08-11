package io.mctest.agent.bukkit.truth;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import io.mctest.agent.core.Canonical;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.bukkit.configuration.serialization.ConfigurationSerializable;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.meta.ItemMeta;

/**
 * Renders a Bukkit {@link ItemStack} as the wire {@code ItemStack} shape (PROTOCOL.md §7.3), with
 * the data components that make an item's identity.
 *
 * <p><b>Why components, not just the material.</b> A modded or plugin item is a vanilla material
 * plus data (custom name, lore, enchantments, custom model data, plugin persistent data). A test
 * that compared {@code type} alone would call a Cobblemon Poké Ball equal to a plain snowball and a
 * ChestShop sign item equal to a blank sign. So every stack carries a canonical {@code components}
 * map and a {@code componentsHash} digest over it: identity is {@code type} + {@code
 * componentsHash}, and the runner asserts on that.
 *
 * <p><b>How the components are obtained without NMS.</b> Bukkit's {@link ItemMeta} is a
 * {@link ConfigurationSerializable}, so {@code meta.serialize()} yields the item's data as a plain
 * map using Bukkit's own stable key names ({@code display-name}, {@code lore}, {@code enchants},
 * {@code custom-model-data}, {@code PublicBukkitValues} for plugin PDC …). Nested serializables
 * (colors, potion effects, items inside a shulker box) are recursively serialized the same way.
 * This is the agent's canonical *view* of the components — deliberately Bukkit-API-shaped rather
 * than a byte-exact vanilla NBT dump, which no Bukkit API exposes.
 */
public final class ItemTruth {

    private ItemTruth() {
    }

    /** Whether the stack is genuinely absent/empty (air or zero amount). */
    public static boolean isEmpty(ItemStack stack) {
        return stack == null || stack.getType().isAir() || stack.getAmount() <= 0;
    }

    /**
     * @param stack a non-empty stack (check {@link #isEmpty} first)
     * @param slot  the slot index to stamp, or {@code null} to omit
     * @return the wire {@code ItemStack} object
     */
    public static JsonObject describe(ItemStack stack, Integer slot) {
        JsonObject out = new JsonObject();
        out.addProperty("type", typeId(stack));
        out.addProperty("count", stack.getAmount());
        if (slot != null) {
            out.addProperty("slot", slot);
        }

        JsonObject components = components(stack);
        ItemMeta meta = safeMeta(stack);
        if (meta != null) {
            String rawName = displayName(meta);
            if (rawName != null) {
                out.addProperty("displayNameRaw", rawName);
                out.addProperty("displayName", stripColors(rawName));
            }
            List<String> lore = safeLore(meta);
            if (lore != null && !lore.isEmpty()) {
                JsonArray arr = new JsonArray();
                for (String line : lore) {
                    arr.add(stripColors(line));
                }
                out.add("lore", arr);
            }
        }

        out.add("components", components);
        // The digest is over type + the SAME canonical components object the caller sees, so a
        // test can compare hashes or inspect the map and always reach the same verdict.
        out.addProperty("componentsHash", Canonical.itemHash(typeId(stack), components));
        return out;
    }

    /** {@code minecraft:diamond_sword} — lowercase namespaced id, never the Bukkit enum name. */
    public static String typeId(ItemStack stack) {
        return stack.getType().getKey().toString().toLowerCase(Locale.ROOT);
    }

    /**
     * The stack's data components as a canonical map. An empty object means "this stack genuinely
     * has no component data" — the field is never omitted, so a reader can distinguish that from
     * "the agent could not look".
     */
    public static JsonObject components(ItemStack stack) {
        ItemMeta meta = safeMeta(stack);
        if (meta == null) {
            return new JsonObject();
        }
        Map<String, Object> serialized;
        try {
            serialized = meta.serialize();
        } catch (RuntimeException e) {
            // A meta type this server cannot serialize: report nothing rather than a half-map that
            // would hash inconsistently between reads.
            return new JsonObject();
        }
        JsonElement json = Canonical.toJson(normalize(serialized));
        return json.isJsonObject() ? json.getAsJsonObject() : new JsonObject();
    }

    /**
     * Recursively replaces nested {@link ConfigurationSerializable}s with their serialized maps, so
     * the whole component tree is plain data (and therefore canonically renderable + hashable).
     */
    private static Object normalize(Object value) {
        if (value instanceof ConfigurationSerializable) {
            return normalize(((ConfigurationSerializable) value).serialize());
        }
        if (value instanceof Map<?, ?>) {
            Map<String, Object> out = new LinkedHashMap<>();
            for (Map.Entry<?, ?> e : ((Map<?, ?>) value).entrySet()) {
                out.put(String.valueOf(e.getKey()), normalize(e.getValue()));
            }
            return out;
        }
        if (value instanceof Iterable<?>) {
            java.util.List<Object> out = new java.util.ArrayList<>();
            for (Object o : (Iterable<?>) value) {
                out.add(normalize(o));
            }
            return out;
        }
        if (value instanceof Object[]) {
            java.util.List<Object> out = new java.util.ArrayList<>();
            for (Object o : (Object[]) value) {
                out.add(normalize(o));
            }
            return out;
        }
        return value;
    }

    private static ItemMeta safeMeta(ItemStack stack) {
        try {
            return stack.hasItemMeta() ? stack.getItemMeta() : null;
        } catch (RuntimeException e) {
            return null;
        }
    }

    private static String displayName(ItemMeta meta) {
        try {
            return meta.hasDisplayName() ? meta.getDisplayName() : null;
        } catch (RuntimeException e) {
            return null;
        }
    }

    private static List<String> safeLore(ItemMeta meta) {
        try {
            return meta.hasLore() ? meta.getLore() : null;
        } catch (RuntimeException e) {
            return null;
        }
    }

    /** Strips legacy §-color codes so `displayName` is comparable text (raw is kept separately). */
    public static String stripColors(String text) {
        if (text == null) {
            return null;
        }
        StringBuilder out = new StringBuilder(text.length());
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if ((c == '§' || c == '&') && i + 1 < text.length()
                    && "0123456789abcdefklmnorABCDEFKLMNOR".indexOf(text.charAt(i + 1)) >= 0) {
                i++; // skip the code character too
                continue;
            }
            out.append(c);
        }
        return out.toString();
    }
}
