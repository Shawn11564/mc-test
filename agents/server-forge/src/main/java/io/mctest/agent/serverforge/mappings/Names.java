package io.mctest.agent.serverforge.mappings;

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
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.ResourceKey;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.Container;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.GameRules;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.biome.Biome;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.Property;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;
import net.minecraftforge.common.MinecraftForge;
import net.minecraftforge.event.server.ServerStartedEvent;
import net.minecraftforge.event.server.ServerStartingEvent;
import net.minecraftforge.event.server.ServerStoppingEvent;
import net.minecraftforge.fml.ModList;
import net.minecraftforge.fml.loading.FMLLoader;

/**
 * The Forge (Mojmap / official Mojang mappings, server-side) {@code Names} facade: the ONLY file in this
 * module that touches {@code net.minecraft.*} / Mojmap / Forge symbols. Everything loader-neutral
 * (handler wiring, selector-free primitives, result shapes, error mapping, the fixture ledger) lives in
 * {@code io.mctest.agent.core} and {@code io.mctest.agent.serverforge.*} and is exercised without
 * Minecraft. This module re-implements only this file vs. {@code server-fabric}'s Yarn-mapped
 * {@code Names.java} — Prime Directive 2; a CI import-scan fails if a {@code net.minecraft.*} import
 * leaks outside {@code mappings/}.
 *
 * <p>It mirrors what the {@code server-fabric} agent does through Yarn-mapped Fabric APIs, but via the
 * Mojmap-mapped Forge server APIs (Forge 1.20.1 develops against official names and reobfuscates to SRG
 * at build): {@link ServerLevel#getBlockState(BlockPos)} for blocks, {@link ServerLevel} entity
 * iteration for entities, {@link GameRules}/{@code setDayTime}/{@code setWeatherParameters} for fixtures.
 * <b>{@code fakePlayers} is intentionally dropped</b> on Forge (no Carpet backend), so there is no
 * {@code /player} console seam here — only the world-truth / fixtures / plugin-state surface. The MCTP
 * dispatch loop runs on a Java-WebSocket worker thread, so every game access bounces onto the server
 * thread via {@link #call(Callable, long)} (mirrors the fabric agent, using {@link MinecraftServer#submit}).
 *
 * <p>The handler classes ({@code WorldTruth}, {@code PluginStateProbe}, {@code FixtureManager}) import
 * ONLY {@code io.mctest.agent.core.*} + this facade and the plain DTOs below; they never name a Minecraft
 * type. The facade returns loader-neutral DTOs (e.g. {@link BlockInfo}, {@link EntityInfo}) so no Gson-
 * or game-typed value crosses back to a handler.
 *
 * <p><b>Acceptance-only.</b> Where a specific Mojmap method spelling is uncertain at authoring time it is
 * marked {@code TODO(acceptance)} — verified against a real ForgeGradle build (this module is not compiled
 * in this repo's CI).
 */
public final class Names {

    private volatile MinecraftServer server;

    public Names() {
    }

    // --- server lifecycle (entrypoint installs plain callbacks; this file owns the mapped events) ---

    /**
     * Registers the Forge server-lifecycle hooks so the {@link MinecraftServer} is captured for the
     * server-thread bounce ({@link #call}) and game access. The entrypoint stays free of
     * {@code net.minecraft.*} by passing plain {@link Runnable}s: {@code onStarted} runs once the server
     * is up (the agent starts its MCTP server there), {@code onStopping} runs at shutdown (the agent
     * stops its MCTP server there). The {@code MinecraftServer} reference never leaves this file.
     *
     * <p>Forge fires {@code ServerStarting/Started/StoppingEvent} on the {@code MinecraftForge.EVENT_BUS}
     * (the game/forge bus, NOT the mod-loading bus); each event carries the {@link MinecraftServer} via
     * {@code event.getServer()}.
     */
    public void installServerLifecycle(Runnable onStarted, Runnable onStopping) {
        // SERVER_STARTING captures the instance as early as possible; STARTED confirms it is running.
        MinecraftForge.EVENT_BUS.addListener((ServerStartingEvent e) -> this.server = e.getServer());
        MinecraftForge.EVENT_BUS.addListener((ServerStartedEvent e) -> {
            this.server = e.getServer();
            if (onStarted != null) {
                onStarted.run();
            }
        });
        MinecraftForge.EVENT_BUS.addListener((ServerStoppingEvent e) -> {
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

    /** @return the running Minecraft version (e.g. {@code "1.20.1"}). */
    public String mcVersion() {
        // SharedConstants is a net.minecraft type; deriving the MC version off the loaded "minecraft"
        // mod container keeps both version getters on the same Forge ModList API.
        return ModList.get().getModContainerById("minecraft")
                .map(c -> c.getModInfo().getVersion().toString())
                .orElse(null);
    }

    /** @return the Forge loader version (e.g. {@code "47.3.39"}). */
    public String loaderVersion() {
        return ModList.get().getModContainerById("forge")
                .map(c -> c.getModInfo().getVersion().toString())
                .orElseGet(Names::forgeVersionFallback);
    }

    /** Fallback Forge version straight off {@code FMLLoader} when the mod container isn't queryable. */
    private static String forgeVersionFallback() {
        return FMLLoader.versionInfo() != null ? FMLLoader.versionInfo().forgeVersion() : null;
    }

    /**
     * @return true if a mod with the given id is loaded (F5 loader-provided {@code mod.loaded} built-in).
     * Backs the {@link io.mctest.agent.core.LoaderPresence} the {@code PluginStateProbe} passes, so a
     * downloaded third-party mod (no SUT SPI) can be asserted present via {@code truth.assertPluginState}.
     */
    public boolean isModLoaded(String id) {
        return id != null && ModList.get().isLoaded(id);
    }

    // --- server-thread bounce (mirror of the fabric agent's call()) ---

    /**
     * Runs {@code body} on the server thread and returns its value, blocking up to {@code timeoutMs}.
     * If already on the server thread (or the server is stopping), runs inline to avoid a self-deadlock
     * and so socket-close cleanups (fixture revert) are not silently swallowed.
     *
     * @throws McTestException {@code TIMEOUT} on overrun, the callable's own {@link McTestException},
     *                         or {@code INTERNAL_ERROR} for any other failure.
     */
    public <T> T call(Callable<T> body, long timeoutMs) throws McTestException {
        MinecraftServer s = this.server;
        // MinecraftServer extends ReentrantBlockableEventLoop → isSameThread(); MinecraftServer adds
        // isRunning()/isStopped() (Mojmap). TODO(acceptance): verify isStopped()/isRunning() spellings.
        if (s == null || s.isSameThread() || s.isStopped() || !s.isRunning()) {
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

    // --- SPI discovery (Forge mechanism: java.util.ServiceLoader, not the Bukkit ServicesManager) ---

    /**
     * Resolves the SUT's state provider via {@link ServiceLoader} against the published core SPI class.
     * On Forge there is no Bukkit {@code ServicesManager}; a SUT mod publishes
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

    /** Resolves a {@link ServerLevel} from a dimension id (e.g. {@code "minecraft:overworld"}), or null. */
    private ServerLevel resolveWorld(String worldName) {
        MinecraftServer s = this.server;
        if (s == null) {
            return null;
        }
        if (worldName != null && !worldName.isEmpty()) {
            ResourceLocation id = ResourceLocation.tryParse(worldName);
            if (id != null) {
                ResourceKey<Level> key = ResourceKey.create(Registries.DIMENSION, id);
                ServerLevel w = s.getLevel(key);
                if (w != null) {
                    return w;
                }
            }
            // Fall through: unknown id → null (handler maps to WORLD_NOT_READY).
            return null;
        }
        // Default to the overworld (mirrors "the player's current world" / Bukkit's first world).
        return s.overworld();
    }

    /**
     * {@code truth.getWorldBlock} primitive: resolve the world, range-check Y, require the chunk loaded,
     * then read the block state. Returns {@code null} when the world is missing → handler raises
     * {@code WORLD_NOT_READY}; throws {@link McTestException#worldNotReady} for out-of-range Y / unloaded
     * chunk to carry the precise reason.
     */
    public BlockInfo getBlock(String worldName, int x, int y, int z) throws McTestException {
        ServerLevel world = resolveWorld(worldName);
        if (world == null) {
            return null;
        }
        // Mojmap: Level#getMinBuildHeight()/getMaxBuildHeight() bound the buildable Y range.
        // TODO(acceptance): verify getMinBuildHeight()/getMaxBuildHeight() spellings on 1.20.1.
        if (y < world.getMinBuildHeight() || y >= world.getMaxBuildHeight()) {
            throw McTestException.worldNotReady("y out of range for world "
                    + worldId(world) + ": " + y);
        }
        // Mojmap: Level#hasChunk(chunkX, chunkZ); loading would mutate state, so treat unloaded as
        // not-ready (retryable). TODO(acceptance): verify hasChunk(int,int) spelling.
        if (!world.hasChunk(x >> 4, z >> 4)) {
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
        ServerLevel world = resolveWorld(worldName);
        if (world == null) {
            return null;
        }
        Vec3 centerVec = new Vec3(cx, cy, cz);
        AABB box = new AABB(cx - radius, cy - radius, cz - radius, cx + radius, cy + radius, cz + radius);
        List<EntityInfo> out = new ArrayList<>();
        // Mojmap: Level#getEntities(Entity except, AABB, Predicate) → use the all-matching predicate.
        // TODO(acceptance): verify getEntities(Entity, AABB, Predicate) overload on 1.20.1 ServerLevel.
        for (Entity entity : world.getEntities((Entity) null, box, e -> true)) {
            // Spherical filter (the box query is a cube).
            if (entity.position().distanceToSqr(centerVec) > radius * radius) {
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
        ServerLevel world = resolveWorld(worldName);
        if (world == null) {
            throw McTestException.fixtureFailed("World not loaded for gamerule");
        }
        GameRules.Key<?> key = findGameRuleKey(ruleName);
        if (key == null) {
            throw McTestException.fixtureFailed("Unknown gamerule: " + ruleName);
        }
        // Mojmap: GameRules#getRule(Key) returns a Value whose toString() serializes the value.
        // TODO(acceptance): verify GameRules.getRule(key).toString() yields the serialized form on 1.20.1.
        return world.getGameRules().getRule(key).toString();
    }

    /** Sets a gamerule by name. Routed through the server's /gamerule command (robust across types). */
    public void setGameRule(String worldName, String ruleName, Object value) throws McTestException {
        ServerLevel world = resolveWorld(worldName);
        if (world == null) {
            throw McTestException.fixtureFailed("World not loaded for gamerule");
        }
        if (findGameRuleKey(ruleName) == null) {
            throw McTestException.fixtureFailed("Unknown gamerule: " + ruleName);
        }
        // GameRules.Value setters are type-specific (CRTP), so set via the server's /gamerule command —
        // robust across rule types (boolean/int) and MC versions. Gamerules are server-wide (stored on
        // the overworld); worldName only gates "loaded".
        dispatchConsoleCommand("gamerule " + ruleName + " " + value);
    }

    /** @return the world's current time-of-day (for the undo record). */
    public long getTime(String worldName) throws McTestException {
        ServerLevel world = resolveWorld(worldName);
        if (world == null) {
            throw McTestException.fixtureFailed("World not loaded for time");
        }
        // Mojmap: Level#getDayTime() is the time-of-day. TODO(acceptance): verify getDayTime() spelling.
        return world.getDayTime();
    }

    public void setTime(String worldName, long time) throws McTestException {
        ServerLevel world = resolveWorld(worldName);
        if (world == null) {
            throw McTestException.fixtureFailed("World not loaded for time");
        }
        // Mojmap: ServerLevel#setDayTime(long). TODO(acceptance): verify setDayTime(long) spelling.
        world.setDayTime(time);
    }

    /** @return {@code [hasStorm, isThundering]} for the undo record. Null world → fixture failed. */
    public boolean[] getWeather(String worldName) throws McTestException {
        ServerLevel world = resolveWorld(worldName);
        if (world == null) {
            throw McTestException.fixtureFailed("World not loaded for weather");
        }
        // Mojmap: Level#isRaining()/isThundering(). TODO(acceptance): verify spellings on 1.20.1.
        return new boolean[] {world.isRaining(), world.isThundering()};
    }

    /** Sets the weather state for the given durations (ticks). */
    public void setWeather(String worldName, boolean raining, boolean thundering)
            throws McTestException {
        ServerLevel world = resolveWorld(worldName);
        if (world == null) {
            throw McTestException.fixtureFailed("World not loaded for weather");
        }
        int on = 6000;
        // Mojmap: ServerLevel#setWeatherParameters(clearTime, weatherTime, raining, thundering).
        // TODO(acceptance): verify setWeatherParameters(int,int,boolean,boolean) spelling on 1.20.1.
        world.setWeatherParameters(raining ? 0 : on, raining ? on : 0, raining, thundering);
    }

    /** Restores a previously captured inventory snapshot onto the (possibly re-fetched) player. */
    public void restoreInventory(Object snapshot) {
        if (!(snapshot instanceof InventorySnapshot)) {
            return;
        }
        InventorySnapshot snap = (InventorySnapshot) snapshot;
        ServerPlayer player = playerByUuid(snap.uuid);
        if (player == null) {
            return;
        }
        // Mojmap: ServerPlayer#getInventory() returns an Inventory (a Container). TODO(acceptance):
        // verify getInventory()/Container.clearContent()/setItem()/getContainerSize() spellings.
        Container inv = player.getInventory();
        inv.clearContent();
        for (int i = 0; i < snap.stacks.size() && i < inv.getContainerSize(); i++) {
            inv.setItem(i, snap.stacks.get(i).copy());
        }
        // Push the inventory change to the client. TODO(acceptance): verify containerMenu.broadcastChanges().
        player.containerMenu.broadcastChanges();
    }

    /** Clears the online player's inventory after capturing it. @return the snapshot, or null. */
    public Object clearInventory(String playerName) {
        ServerPlayer player = onlinePlayer(playerName);
        if (player == null) {
            return null;
        }
        InventorySnapshot snap = new InventorySnapshot(player.getUUID(),
                copyInventory(player.getInventory()));
        player.getInventory().clearContent();
        player.containerMenu.broadcastChanges();
        return snap;
    }

    /**
     * Gives {@code count} of {@code itemId} to the online player, capturing the prior inventory for an
     * exact undo (mirrors the fabric snapshot-and-restore). @return the snapshot, or null if not online.
     * @throws McTestException if the item id is unknown.
     */
    public Object giveItem(String playerName, String itemId, int count) throws McTestException {
        ServerPlayer player = onlinePlayer(playerName);
        if (player == null) {
            return null;
        }
        ResourceLocation id = ResourceLocation.tryParse(itemId);
        // Mojmap: BuiltInRegistries.ITEM is the item registry; get(ResourceLocation) returns AIR for an
        // unknown id. TODO(acceptance): verify BuiltInRegistries.ITEM.get(ResourceLocation) on 1.20.1.
        Item item = id != null ? BuiltInRegistries.ITEM.get(id) : null;
        if (item == null || item == Items.AIR) {
            throw McTestException.fixtureFailed("Unknown item: " + itemId);
        }
        InventorySnapshot snap = new InventorySnapshot(player.getUUID(),
                copyInventory(player.getInventory()));
        // Mojmap: Inventory#add(ItemStack) inserts into the first free slot(s). TODO(acceptance):
        // verify Inventory.add(ItemStack) spelling on 1.20.1.
        player.getInventory().add(new ItemStack(item, Math.max(1, count)));
        player.containerMenu.broadcastChanges();
        return snap;
    }

    /**
     * Server-mod note: vanilla Forge has no per-player permission attachment like Bukkit. A permissions
     * fixture is therefore delegated to the SUT fixture provider when present; the built-in recipe is
     * unsupported here and the handler reports {@code FIXTURE_FAILED} (honest, not a false green).
     */
    public boolean supportsBuiltInPermissions() {
        return false;
    }

    // --- console command dispatch (server command source at permission level 4) ---

    /**
     * Dispatches one console command through the server command dispatcher with full permissions
     * (mirrors the Bukkit agent's {@code Bukkit.dispatchCommand(consoleSender, …)}). Used for the
     * {@code /gamerule …} fixture path. Forge/NeoForge servers have no Carpet fake-player backend, so
     * this seam exists only for the gamerule recipe (fakePlayers is dropped on these loaders).
     *
     * @throws McTestException if no server is available.
     */
    public void dispatchConsoleCommand(String command) throws McTestException {
        MinecraftServer s = this.server;
        if (s == null) {
            throw McTestException.internal("No server available to dispatch: " + command);
        }
        // Mojmap: MinecraftServer#createCommandSourceStack() is the server console source (permission 4);
        // getCommands().performPrefixedCommand(source, cmd) runs a command that may include a leading '/'.
        // TODO(acceptance): verify createCommandSourceStack()/performPrefixedCommand(CommandSourceStack,String).
        s.getCommands().performPrefixedCommand(s.createCommandSourceStack(), command);
    }

    // --- private helpers (Mojmap-mapped; confined to this file) ---

    private ServerPlayer onlinePlayer(String name) {
        MinecraftServer s = this.server;
        // Mojmap: MinecraftServer#getPlayerList().getPlayerByName(name). TODO(acceptance): verify spelling.
        return s != null ? s.getPlayerList().getPlayerByName(name) : null;
    }

    private ServerPlayer playerByUuid(java.util.UUID uuid) {
        MinecraftServer s = this.server;
        // Mojmap: PlayerList#getPlayer(UUID). TODO(acceptance): verify getPlayer(UUID) spelling.
        return s != null ? s.getPlayerList().getPlayer(uuid) : null;
    }

    private static List<ItemStack> copyInventory(Container inv) {
        List<ItemStack> out = new ArrayList<>(inv.getContainerSize());
        for (int i = 0; i < inv.getContainerSize(); i++) {
            out.add(inv.getItem(i).copy());
        }
        return out;
    }

    private GameRules.Key<?> findGameRuleKey(String name) {
        GameRules.Key<?>[] found = new GameRules.Key<?>[1];
        // Mojmap: GameRules.visitGameRuleTypes(Visitor) walks every (Key, Type). TODO(acceptance):
        // verify visitGameRuleTypes(Visitor)/Visitor.visit(Key,Type)/Key.getId() spellings on 1.20.1.
        GameRules.visitGameRuleTypes(new GameRules.GameRuleTypeVisitor() {
            @Override
            public <T extends GameRules.Value<T>> void visit(GameRules.Key<T> key,
                                                             GameRules.Type<T> type) {
                if (found[0] == null && key.getId().equals(name)) {
                    found[0] = key;
                }
            }
        });
        return found[0];
    }

    private static String worldId(Level world) {
        // Mojmap: Level#dimension() → ResourceKey<Level>; location() is its ResourceLocation.
        return world.dimension().location().toString();
    }

    private static String blockId(BlockState state) {
        Block block = state.getBlock();
        ResourceLocation id = BuiltInRegistries.BLOCK.getKey(block);
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
        // Mojmap: Property#getName(T) renders the value's serialized name. TODO(acceptance): verify
        // getName(T value) spelling on 1.20.1 (Yarn's analogue is Property#name(T)).
        return property.getName(state.getValue(property));
    }

    private static String biomeId(ServerLevel world, BlockPos pos) {
        // Mojmap: Level#getBiome(BlockPos) → Holder<Biome>; unwrapKey() yields the registry key.
        // TODO(acceptance): verify getBiome().unwrapKey()/registryAccess().registryOrThrow(...) on 1.20.1.
        var holder = world.getBiome(pos);
        return holder.unwrapKey()
                .map((ResourceKey<Biome> key) -> key.location().toString())
                .orElseGet(() -> {
                    ResourceLocation id = world.registryAccess()
                            .registryOrThrow(Registries.BIOME).getKey(holder.value());
                    return id != null ? id.toString() : "minecraft:plains";
                });
    }

    private static String entityTypeId(Entity entity) {
        EntityType<?> type = entity.getType();
        ResourceLocation id = BuiltInRegistries.ENTITY_TYPE.getKey(type);
        return id.toString();
    }

    private static EntityInfo describeEntity(Entity entity, String type) {
        EntityInfo e = new EntityInfo();
        // 64-bit entity id transmitted as a string (PROTOCOL.md §2.2).
        e.id = "e_" + entity.getId();
        e.uuid = entity.getStringUUID();
        e.type = type;
        if (entity.getName() != null) {
            e.name = entity.getName().getString();
        }
        Vec3 pos = entity.position();
        e.x = pos.x;
        e.y = pos.y;
        e.z = pos.z;
        // Mojmap: Entity#getTags() is the command-tag set. TODO(acceptance): verify getTags() spelling.
        e.tags = new ArrayList<>(entity.getTags());
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
