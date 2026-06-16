package io.mctest.agent.serverfabric.mappings;

import io.mctest.agent.core.McTestException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.ServiceLoader;
import java.util.concurrent.Callable;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.entity.Entity;
import net.minecraft.inventory.Inventory;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.registry.Registries;
import net.minecraft.registry.RegistryKey;
import net.minecraft.registry.RegistryKeys;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.command.ServerCommandSource;
import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.server.world.ServerWorld;
import net.minecraft.state.property.Property;
import net.minecraft.util.Identifier;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.Vec3d;
import net.minecraft.world.GameRules;
import net.minecraft.world.World;
import net.minecraft.world.biome.Biome;
import net.minecraft.block.Block;
import net.minecraft.block.BlockState;
import net.minecraft.entity.EntityType;

/**
 * The Fabric (Yarn-mapped, server-side) {@code Names} facade: the ONLY file in this module that touches
 * {@code net.minecraft.*} / Yarn symbols. Everything loader-neutral (handler wiring, selector-free
 * primitives, result shapes, error mapping, the fixture ledger) lives in {@code io.mctest.agent.core}
 * and {@code io.mctest.agent.serverfabric.*} and is exercised without Minecraft. M5 fan-out
 * (NeoForge server / other MC versions) re-implements only this file — Prime Directive 2; a CI
 * import-scan fails if a {@code net.minecraft.*} import leaks outside {@code mappings/}.
 *
 * <p>It mirrors what the {@code server-bukkit} agent does through the Bukkit API, but via Fabric server
 * APIs: {@link ServerWorld#getBlockState(BlockPos)} for blocks, {@link ServerWorld} entity iteration
 * for entities, {@link GameRules}/{@code setTimeOfDay}/{@code setWeather} for fixtures, and the Carpet
 * {@code /player} console command (dispatched via {@link MinecraftServer#getCommandManager()}) for fake
 * players. The MCTP dispatch loop runs on a Java-WebSocket worker thread, so every game access bounces
 * onto the server thread via {@link #call(Callable, long)} (mirrors the Bukkit agent's
 * {@code MainThread}, but using {@link MinecraftServer#submit}/{@code execute}).
 *
 * <p>The handler classes ({@code WorldTruth}, {@code PluginStateProbe}, {@code FixtureManager},
 * {@code FakePlayerManager}) import ONLY {@code io.mctest.agent.core.*} + this facade and the plain DTOs
 * below; they never name a Minecraft type. The facade returns loader-neutral DTOs (e.g. {@link BlockInfo},
 * {@link EntityInfo}) so no Gson- or game-typed value crosses back to a handler.
 */
public final class Names {

    private volatile MinecraftServer server;

    public Names() {
    }

    // --- server lifecycle (entrypoint installs plain callbacks; this file owns the mapped events) ---

    /**
     * Registers the Fabric server-lifecycle hooks so the {@link MinecraftServer} is captured for the
     * server-thread bounce ({@link #call}) and game access. The entrypoint stays free of
     * {@code net.minecraft.*} by passing plain {@link Runnable}s: {@code onStarted} runs once the server
     * is up (the agent starts its MCTP server there), {@code onStopping} runs at shutdown (the agent
     * stops its MCTP server there). The {@code MinecraftServer} reference never leaves this file.
     */
    public void installServerLifecycle(Runnable onStarted, Runnable onStopping) {
        // SERVER_STARTING captures the instance as early as possible; STARTED confirms it is running.
        ServerLifecycleEvents.SERVER_STARTING.register(s -> this.server = s);
        ServerLifecycleEvents.SERVER_STARTED.register(s -> {
            this.server = s;
            if (onStarted != null) {
                onStarted.run();
            }
        });
        ServerLifecycleEvents.SERVER_STOPPING.register(s -> {
            if (onStopping != null) {
                onStopping.run();
            }
            this.server = null;
        });
    }

    /** @return true once the dedicated server is captured (SERVER_STARTING/STARTED fired). */
    public boolean hasServer() {
        return server != null;
    }

    // --- version strings (loader-specific; supplied to the Dispatch by the entrypoint) ---

    /** @return the running Minecraft version (e.g. {@code "1.21.1"}). */
    public String mcVersion() {
        return FabricLoader.getInstance().getModContainer("minecraft")
                .map(m -> m.getMetadata().getVersion().getFriendlyString())
                .orElse(null);
    }

    /** @return the Fabric loader version (e.g. {@code "0.16.5"}). */
    public String loaderVersion() {
        return FabricLoader.getInstance().getModContainer("fabricloader")
                .map(m -> m.getMetadata().getVersion().getFriendlyString())
                .orElse(null);
    }

    // --- server-thread bounce (mirror of the Bukkit agent's MainThread.call) ---

    /**
     * Runs {@code body} on the server thread and returns its value, blocking up to {@code timeoutMs}.
     * If already on the server thread (or the server is stopping), runs inline to avoid a self-deadlock
     * and so socket-close cleanups (fixture revert, fake-player despawn) are not silently swallowed.
     *
     * @throws McTestException {@code TIMEOUT} on overrun, the callable's own {@link McTestException},
     *                         or {@code INTERNAL_ERROR} for any other failure.
     */
    public <T> T call(Callable<T> body, long timeoutMs) throws McTestException {
        MinecraftServer s = this.server;
        if (s == null || s.isOnThread() || s.isStopping() || !s.isRunning()) {
            return callInline(body);
        }
        CompletableFuture<T> future;
        try {
            // MinecraftServer.submit(Supplier) schedules onto the main server thread and returns a future.
            future = s.submit(() -> {
                try {
                    return body.call();
                } catch (Exception e) {
                    throw new RuntimeException(e);
                }
            });
        } catch (RuntimeException e) {
            // Server became unavailable between the guard and submit — degrade to inline.
            return callInline(body);
        }
        try {
            return future.get(Math.max(1L, timeoutMs), TimeUnit.MILLISECONDS);
        } catch (TimeoutException e) {
            future.cancel(true);
            throw McTestException.timeout("Server-thread call exceeded " + timeoutMs + "ms");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw McTestException.internal("Interrupted waiting for server thread");
        } catch (ExecutionException e) {
            throw unwrap(e.getCause());
        }
    }

    private static <T> T callInline(Callable<T> body) throws McTestException {
        try {
            return body.call();
        } catch (McTestException e) {
            throw e;
        } catch (Exception e) {
            throw McTestException.internal("Server-thread call failed: " + describe(e));
        }
    }

    /** Unwraps the cause chain MinecraftServer.submit wraps so a handler's typed error survives. */
    private static McTestException unwrap(Throwable cause) {
        Throwable t = cause;
        while (t != null) {
            if (t instanceof McTestException) {
                return (McTestException) t;
            }
            t = t.getCause();
        }
        return McTestException.internal("Server-thread call failed: " + describe(cause));
    }

    // --- SPI discovery (Fabric mechanism: java.util.ServiceLoader, not the Bukkit ServicesManager) ---

    /**
     * Resolves the SUT's state provider via {@link ServiceLoader} against the published core SPI class.
     * On Fabric there is no Bukkit {@code ServicesManager}; a SUT mod publishes
     * {@code io.mctest.agent.core.McTestStateProvider} in its
     * {@code META-INF/services/io.mctest.agent.core.McTestStateProvider} so the agent (sharing the exact
     * class via the bundled core) discovers it on the common mod classloader.
     *
     * @return the first registered provider, or {@code null}.
     */
    public io.mctest.agent.core.McTestStateProvider lookupStateProvider() {
        return firstOf(ServiceLoader.load(io.mctest.agent.core.McTestStateProvider.class,
                getClass().getClassLoader()));
    }

    /** Resolves the SUT's fixture provider via {@link ServiceLoader} (see {@link #lookupStateProvider}). */
    public io.mctest.agent.core.McTestFixtureProvider lookupFixtureProvider() {
        return firstOf(ServiceLoader.load(io.mctest.agent.core.McTestFixtureProvider.class,
                getClass().getClassLoader()));
    }

    private static <T> T firstOf(ServiceLoader<T> loader) {
        java.util.Iterator<T> it = loader.iterator();
        return it.hasNext() ? it.next() : null;
    }

    // --- world / block / entity reads (server thread; callers wrap in call()) ---

    /** @return true if a world with the given dimension id (e.g. {@code "minecraft:overworld"}) is loaded. */
    private ServerWorld resolveWorld(String worldName) {
        MinecraftServer s = this.server;
        if (s == null) {
            return null;
        }
        if (worldName != null && !worldName.isEmpty()) {
            Identifier id = Identifier.tryParse(worldName);
            if (id != null) {
                RegistryKey<World> key = RegistryKey.of(RegistryKeys.WORLD, id);
                ServerWorld w = s.getWorld(key);
                if (w != null) {
                    return w;
                }
            }
            // Fall through: unknown id → null (handler maps to WORLD_NOT_READY).
            return null;
        }
        // Default to the overworld (mirrors "the player's current world" / Bukkit's first world).
        return s.getOverworld();
    }

    /**
     * {@code truth.getWorldBlock} primitive: resolve the world, range-check Y, require the chunk loaded,
     * then read the block state. Returns {@code null} when the world is missing → handler raises
     * {@code WORLD_NOT_READY}; throws {@link McTestException#worldNotReady} for out-of-range Y / unloaded
     * chunk to carry the precise reason.
     */
    public BlockInfo getBlock(String worldName, int x, int y, int z) throws McTestException {
        ServerWorld world = resolveWorld(worldName);
        if (world == null) {
            return null;
        }
        if (y < world.getBottomY() || y >= world.getTopY()) {
            throw McTestException.worldNotReady("y out of range for world "
                    + worldId(world) + ": " + y);
        }
        if (!world.isChunkLoaded(x >> 4, z >> 4)) {
            // Loading would mutate state; treat an unloaded chunk as not-ready (retryable).
            throw McTestException.worldNotReady("Chunk not loaded at " + x + "," + z);
        }
        BlockPos pos = new BlockPos(x, y, z);
        BlockState state = world.getBlockState(pos);
        BlockInfo info = new BlockInfo();
        info.type = blockId(state).toLowerCase(java.util.Locale.ROOT);
        info.properties = blockProperties(state);
        info.biome = biomeId(world, pos);
        return info;
    }

    /**
     * {@code truth.getEntities} primitive: spherical query around {@code center} within {@code radius}.
     * Returns {@code null} when the world is missing → handler raises {@code WORLD_NOT_READY}.
     */
    public List<EntityInfo> getEntities(String worldName, double cx, double cy, double cz,
                                        double radius, String typeFilter) {
        ServerWorld world = resolveWorld(worldName);
        if (world == null) {
            return null;
        }
        Vec3d centerVec = new Vec3d(cx, cy, cz);
        Box box = new Box(cx - radius, cy - radius, cz - radius, cx + radius, cy + radius, cz + radius);
        List<EntityInfo> out = new ArrayList<>();
        for (Entity entity : world.getOtherEntities(null, box)) {
            // Spherical filter (the box query is a cube).
            if (entity.getPos().squaredDistanceTo(centerVec) > radius * radius) {
                continue;
            }
            String type = entityTypeId(entity);
            if (typeFilter != null && !typeFilter.equals(type)) {
                continue;
            }
            out.add(describeEntity(entity, type));
        }
        return out;
    }

    // --- fixtures: gamerule / time / weather / inventory / permissions (server thread) ---

    /** Reads a gamerule's current value as a string (for the undo record). Null world → null. */
    public String getGameRule(String worldName, String ruleName) throws McTestException {
        ServerWorld world = resolveWorld(worldName);
        if (world == null) {
            throw McTestException.fixtureFailed("World not loaded for gamerule");
        }
        GameRules.Key<?> key = findGameRuleKey(ruleName);
        if (key == null) {
            throw McTestException.fixtureFailed("Unknown gamerule: " + ruleName);
        }
        return world.getGameRules().get(key).serialize();
    }

    /** Sets a gamerule by name on the given world. Coerces against the rule's value type. */
    public void setGameRule(String worldName, String ruleName, Object value) throws McTestException {
        ServerWorld world = resolveWorld(worldName);
        if (world == null) {
            throw McTestException.fixtureFailed("World not loaded for gamerule");
        }
        GameRules.Key<?> key = findGameRuleKey(ruleName);
        if (key == null) {
            throw McTestException.fixtureFailed("Unknown gamerule: " + ruleName);
        }
        GameRules.Rule<?> rule = world.getGameRules().get(key);
        // setValue parses the serialized string form, which is robust across rule types.
        rule.setValue(parseGameRule(rule, value), server);
    }

    /** @return the world's current time-of-day (for the undo record). */
    public long getTime(String worldName) throws McTestException {
        ServerWorld world = resolveWorld(worldName);
        if (world == null) {
            throw McTestException.fixtureFailed("World not loaded for time");
        }
        return world.getTimeOfDay();
    }

    public void setTime(String worldName, long time) throws McTestException {
        ServerWorld world = resolveWorld(worldName);
        if (world == null) {
            throw McTestException.fixtureFailed("World not loaded for time");
        }
        world.setTimeOfDay(time);
    }

    /** @return {@code [hasStorm, isThundering]} for the undo record. Null world → fixture failed. */
    public boolean[] getWeather(String worldName) throws McTestException {
        ServerWorld world = resolveWorld(worldName);
        if (world == null) {
            throw McTestException.fixtureFailed("World not loaded for weather");
        }
        return new boolean[] {world.isRaining(), world.isThundering()};
    }

    /** Sets the weather state. {@code clearDuration}/{@code rainDuration}/{@code thunderDuration} ticks. */
    public void setWeather(String worldName, boolean raining, boolean thundering)
            throws McTestException {
        ServerWorld world = resolveWorld(worldName);
        if (world == null) {
            throw McTestException.fixtureFailed("World not loaded for weather");
        }
        int on = 6000;
        // setWeather(clearDuration, rainDuration, raining, thundering).
        world.setWeather(raining ? 0 : on, raining ? on : 0, raining, thundering);
    }

    /** @return a serialized snapshot of the online player's inventory, or null if not online. */
    public Object snapshotInventory(String playerName) {
        ServerPlayerEntity player = onlinePlayer(playerName);
        if (player == null) {
            return null;
        }
        return new InventorySnapshot(player.getUuid(), copyInventory(player.getInventory()));
    }

    /** Restores a previously captured inventory snapshot onto the (possibly re-fetched) player. */
    public void restoreInventory(Object snapshot) {
        if (!(snapshot instanceof InventorySnapshot)) {
            return;
        }
        InventorySnapshot snap = (InventorySnapshot) snapshot;
        ServerPlayerEntity player = playerByUuid(snap.uuid);
        if (player == null) {
            return;
        }
        Inventory inv = player.getInventory();
        inv.clear();
        for (int i = 0; i < snap.stacks.size() && i < inv.size(); i++) {
            inv.setStack(i, snap.stacks.get(i).copy());
        }
        player.currentScreenHandler.sendContentUpdates();
    }

    /** Clears the online player's inventory after capturing it. @return the snapshot, or null. */
    public Object clearInventory(String playerName) {
        ServerPlayerEntity player = onlinePlayer(playerName);
        if (player == null) {
            return null;
        }
        InventorySnapshot snap = new InventorySnapshot(player.getUuid(),
                copyInventory(player.getInventory()));
        player.getInventory().clear();
        player.currentScreenHandler.sendContentUpdates();
        return snap;
    }

    /**
     * Gives {@code count} of {@code itemId} to the online player, capturing the prior inventory for an
     * exact undo (mirrors the Bukkit snapshot-and-restore). @return the snapshot, or null if not online.
     * @throws McTestException if the item id is unknown.
     */
    public Object giveItem(String playerName, String itemId, int count) throws McTestException {
        ServerPlayerEntity player = onlinePlayer(playerName);
        if (player == null) {
            return null;
        }
        Identifier id = Identifier.tryParse(itemId);
        Item item = id != null ? Registries.ITEM.get(id) : null;
        // Registries.ITEM.get returns AIR for an unknown id; reject it.
        if (item == null || item == net.minecraft.item.Items.AIR) {
            throw McTestException.fixtureFailed("Unknown item: " + itemId);
        }
        InventorySnapshot snap = new InventorySnapshot(player.getUuid(),
                copyInventory(player.getInventory()));
        player.getInventory().insertStack(new ItemStack(item, Math.max(1, count)));
        player.currentScreenHandler.sendContentUpdates();
        return snap;
    }

    /**
     * Server-mod note: vanilla Fabric has no per-player permission attachment like Bukkit. A permissions
     * fixture is therefore delegated to the SUT fixture provider when present; the built-in recipe is
     * unsupported here and the handler reports {@code FIXTURE_FAILED} (honest, not a false green).
     */
    public boolean supportsBuiltInPermissions() {
        return false;
    }

    // --- fake players (Carpet /player console command via the server command dispatcher) ---

    /**
     * Dispatches one console command through the server command manager with full permissions
     * (mirrors the Bukkit agent's {@code Bukkit.dispatchCommand(consoleSender, …)}). Used for the
     * Carpet {@code /player <name> spawn at …} and {@code /player <name> kill} commands.
     *
     * @throws McTestException if no server is available.
     */
    public void dispatchConsoleCommand(String command) throws McTestException {
        MinecraftServer s = this.server;
        if (s == null) {
            throw McTestException.internal("No server available to dispatch: " + command);
        }
        ServerCommandSource source = s.getCommandSource()
                .withLevel(4)
                .withSilent();
        s.getCommandManager().executeWithPrefix(source, command);
    }

    /** @return the joined fake player's UUID (best-effort) after a Carpet spawn, or null if not yet joined. */
    public String onlinePlayerUuid(String name) {
        ServerPlayerEntity player = onlinePlayer(name);
        return player != null ? player.getUuid().toString() : null;
    }

    // --- private helpers (Yarn-mapped; confined to this file) ---

    private ServerPlayerEntity onlinePlayer(String name) {
        MinecraftServer s = this.server;
        return s != null ? s.getPlayerManager().getPlayer(name) : null;
    }

    private ServerPlayerEntity playerByUuid(java.util.UUID uuid) {
        MinecraftServer s = this.server;
        return s != null ? s.getPlayerManager().getPlayer(uuid) : null;
    }

    private static List<ItemStack> copyInventory(Inventory inv) {
        List<ItemStack> out = new ArrayList<>(inv.size());
        for (int i = 0; i < inv.size(); i++) {
            out.add(inv.getStack(i).copy());
        }
        return out;
    }

    private GameRules.Key<?> findGameRuleKey(String name) {
        GameRules.Key<?>[] found = new GameRules.Key<?>[1];
        GameRules.accept(new GameRules.Visitor() {
            @Override
            public <T extends GameRules.Rule<T>> void visit(GameRules.Key<T> key,
                                                            GameRules.Type<T> type) {
                if (found[0] == null && key.getName().equals(name)) {
                    found[0] = key;
                }
            }
        });
        return found[0];
    }

    private static String parseGameRule(GameRules.Rule<?> rule, Object value) {
        // Rule.setValue parses a serialized string; both bool and int rules accept their string form.
        return String.valueOf(value);
    }

    private static String worldId(World world) {
        return world.getRegistryKey().getValue().toString();
    }

    private static String blockId(BlockState state) {
        Block block = state.getBlock();
        Identifier id = Registries.BLOCK.getId(block);
        return id.toString();
    }

    /** Extracts the blockstate properties as a {@code name → value} map (no NMS string parsing needed). */
    private static Map<String, String> blockProperties(BlockState state) {
        Map<String, String> props = new LinkedHashMap<>();
        for (Property<?> property : state.getProperties()) {
            props.put(property.getName(), valueName(state, property));
        }
        return props;
    }

    private static <T extends Comparable<T>> String valueName(BlockState state, Property<T> property) {
        return property.name(state.get(property));
    }

    private static String biomeId(ServerWorld world, BlockPos pos) {
        var entry = world.getBiome(pos);
        return entry.getKeyOrValue().map(
                (RegistryKey<Biome> key) -> key.getValue().toString(),
                (Biome biome) -> {
                    Identifier id = world.getRegistryManager()
                            .get(RegistryKeys.BIOME).getId(biome);
                    return id != null ? id.toString() : "minecraft:plains";
                });
    }

    private static String entityTypeId(Entity entity) {
        EntityType<?> type = entity.getType();
        Identifier id = Registries.ENTITY_TYPE.getId(type);
        return id.toString();
    }

    private static EntityInfo describeEntity(Entity entity, String type) {
        EntityInfo e = new EntityInfo();
        // 64-bit entity id transmitted as a string (PROTOCOL.md §2.2).
        e.id = "e_" + entity.getId();
        e.uuid = entity.getUuidAsString();
        e.type = type;
        if (entity.getName() != null) {
            e.name = entity.getName().getString();
        }
        Vec3d pos = entity.getPos();
        e.x = pos.x;
        e.y = pos.y;
        e.z = pos.z;
        e.tags = new ArrayList<>(entity.getCommandTags());
        if (entity.getCustomName() != null) {
            e.customNameRaw = entity.getCustomName().getString();
        }
        return e;
    }

    private static String describe(Throwable t) {
        if (t == null) {
            return "unknown";
        }
        String msg = t.getMessage();
        return msg != null ? t.getClass().getSimpleName() + ": " + msg : t.getClass().getSimpleName();
    }

    // --- loader-neutral DTOs returned to the handlers (NO game types cross back) ---

    /** Block read result: {@code type} (lowercase {@code namespace:path}), properties, biome id. */
    public static final class BlockInfo {
        public String type;
        public Map<String, String> properties;
        public String biome;
    }

    /** Entity read result mirroring the {@code truth.getEntities} element shape (PROTOCOL.md §7.3). */
    public static final class EntityInfo {
        public String id;
        public String uuid;
        public String type;
        public String name;
        public double x;
        public double y;
        public double z;
        public List<String> tags;
        public String customNameRaw;
    }

    /** Opaque per-player inventory snapshot for an exact fixture undo (game-typed; never leaves this file). */
    private static final class InventorySnapshot {
        final java.util.UUID uuid;
        final List<ItemStack> stacks;

        InventorySnapshot(java.util.UUID uuid, List<ItemStack> stacks) {
            this.uuid = uuid;
            this.stacks = stacks;
        }
    }
}
