package io.mctest.agent.serverforge.mappings;

import com.mojang.authlib.GameProfile;
import io.mctest.agent.core.McTestException;
import io.mctest.agent.core.MenuView;
import io.netty.channel.embedded.EmbeddedChannel;
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
import net.minecraft.commands.arguments.EntityAnchorArgument;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.network.Connection;
import net.minecraft.network.PacketSendListener;
import net.minecraft.network.chat.ChatType;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.PlayerChatMessage;
import net.minecraft.network.protocol.Packet;
import net.minecraft.network.protocol.PacketFlow;
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
import net.minecraft.world.InteractionHand;
import net.minecraft.world.InteractionResult;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.ListTag;
import net.minecraft.nbt.Tag;
import net.minecraft.world.inventory.AbstractContainerMenu;
import net.minecraft.world.inventory.Slot;
import net.minecraft.world.inventory.ClickType;
import net.minecraft.world.level.GameType;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;
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
 * {@code fakePlayers} is <b>native</b> here as of spec/42 (the "no Carpet backend" rationale went
 * stale when server-fabric proved the {@code placeNewPlayer}-behind-a-discard-connection path needs no
 * Carpet): a real {@link ServerPlayer} on the real join path, plus the {@code player.act} verb surface
 * and the {@code /actor} command. The MCTP
 * dispatch loop runs on a Java-WebSocket worker thread, so every game access bounces onto the server
 * thread via {@link #call(Callable, long)} (mirrors the fabric agent, using {@link MinecraftServer#submit}).
 *
 * <p>The handler classes ({@code WorldTruth}, {@code PluginStateProbe}, {@code FixtureManager}) import
 * ONLY {@code io.mctest.agent.core.*} + this facade and the plain DTOs below; they never name a Minecraft
 * type. The facade returns loader-neutral DTOs (e.g. {@link BlockInfo}, {@link EntityInfo}) so no Gson-
 * or game-typed value crosses back to a handler.
 *
 * <p><b>Build-verified.</b> This module is BUILT (ForgeGradle, MC 1.20.1, Forge 47.3.39, on Java 17) and
 * booted on a real Forge 1.20.1 dedicated server: the Mojmap method spellings below COMPILED against the
 * real Forge Mojmap mappings, and the lifecycle + {@code mod.loaded} path is runtime-proven over MCTP.
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
        // isRunning()/isStopped() (Mojmap).
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
        if (y < world.getMinBuildHeight() || y >= world.getMaxBuildHeight()) {
            throw McTestException.worldNotReady("y out of range for world "
                    + worldId(world) + ": " + y);
        }
        // Mojmap: Level#hasChunk(chunkX, chunkZ); loading would mutate state, so treat unloaded as
        // not-ready (retryable).
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
        // Mojmap: Level#getDayTime() is the time-of-day.
        return world.getDayTime();
    }

    public void setTime(String worldName, long time) throws McTestException {
        ServerLevel world = resolveWorld(worldName);
        if (world == null) {
            throw McTestException.fixtureFailed("World not loaded for time");
        }
        // Mojmap: ServerLevel#setDayTime(long).
        world.setDayTime(time);
    }

    /** @return {@code [hasStorm, isThundering]} for the undo record. Null world → fixture failed. */
    public boolean[] getWeather(String worldName) throws McTestException {
        ServerLevel world = resolveWorld(worldName);
        if (world == null) {
            throw McTestException.fixtureFailed("World not loaded for weather");
        }
        // Mojmap: Level#isRaining()/isThundering().
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
        // Mojmap: ServerPlayer#getInventory() returns an Inventory (a Container).
        Container inv = player.getInventory();
        inv.clearContent();
        for (int i = 0; i < snap.stacks.size() && i < inv.getContainerSize(); i++) {
            inv.setItem(i, snap.stacks.get(i).copy());
        }
        // Push the inventory change to the client.
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
        // unknown id.
        Item item = id != null ? BuiltInRegistries.ITEM.get(id) : null;
        if (item == null || item == Items.AIR) {
            throw McTestException.fixtureFailed("Unknown item: " + itemId);
        }
        InventorySnapshot snap = new InventorySnapshot(player.getUUID(),
                copyInventory(player.getInventory()));
        // Mojmap: Inventory#add(ItemStack) inserts into the first free slot(s).
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
        s.getCommands().performPrefixedCommand(s.createCommandSourceStack(), command);
    }

    // --- native fake players (spec/41 tier 2 pattern, ported to Mojmap 1.20.1; spec/42 brings it here) ---
    //
    // The "player" is a real ServerPlayer joined through PlayerList.placeNewPlayer behind a Connection
    // that discards every outbound packet (activated via an EmbeddedChannel so the connection looks open
    // without a socket). Every join/leave/interact hook fires exactly as for a human; no Carpet mod is
    // required. On Forge the interaction events (AttackEntityEvent, EntityInteract, RightClickBlock)
    // are fired INSIDE the vanilla methods by the loader's patches — unlike Fabric, where the callbacks
    // live in the packet handler and the facade must invoke them explicitly — so calling the vanilla
    // method is the faithful full sequence. Identity is the deterministic offline UUID, stable across
    // sessions and tiers. All of these are server-thread primitives; handlers wrap them in call().

    /**
     * Joins a native fake player. Optional spawn position and game mode.
     *
     * @return the joined player's UUID string.
     * @throws McTestException {@code invalidParams} if already online or the game mode is unknown;
     *                         {@code internal} if the join path fails.
     */
    public String spawnFakePlayer(String name, Double x, Double y, Double z, String gameMode)
            throws McTestException {
        MinecraftServer s = requireServer();
        java.util.UUID id = java.util.UUID.nameUUIDFromBytes(
                ("OfflinePlayer:" + name).getBytes(java.nio.charset.StandardCharsets.UTF_8));
        if (s.getPlayerList().getPlayer(id) != null) {
            throw McTestException.invalidParams("Fake player already online: " + name);
        }
        GameType mode = null;
        if (gameMode != null && !gameMode.isEmpty()) {
            mode = GameType.byName(gameMode, null);
            if (mode == null) {
                throw McTestException.invalidParams("Unknown gameMode: " + gameMode);
            }
        }
        GameProfile profile = new GameProfile(id, name);
        FakeAvatar player = new FakeAvatar(s, s.overworld(), profile);
        DiscardingConnection connection = new DiscardingConnection();
        // Activating an EmbeddedChannel with the connection as its handler runs channelActive, which
        // adopts the channel — the supported way to make an unregistered connection look connected.
        new EmbeddedChannel(connection);
        try {
            // 1.20.1: the pre-config-phase two-arg join (no CommonListenerCookie/ClientInformation).
            s.getPlayerList().placeNewPlayer(connection, player);
        } catch (Exception e) {
            throw McTestException.internal("Native fake-player join failed for '" + name + "': "
                    + describe(e));
        }
        if (x != null && y != null && z != null) {
            player.teleportTo(s.overworld(), x, y, z, player.getYRot(), player.getXRot());
        }
        if (mode != null) {
            player.setGameMode(mode);
        }
        return id.toString();
    }

    /**
     * Disconnects a native fake player through the real leave path, so leave events fire.
     *
     * @return true if the player was online and is now disconnected; false if not online.
     */
    public boolean despawnFakePlayer(String name) {
        ServerPlayer player = onlinePlayer(name);
        if (player == null) {
            return false;
        }
        if (!player.hasDisconnected()) {
            // 1.20.1: onDisconnect takes the reason Component directly (DisconnectionDetails is 1.21+).
            player.connection.onDisconnect(Component.literal("mc-test despawn"));
        }
        return true;
    }

    /** Broadcasts an unsigned player chat message from the fake player. */
    public void actChat(String name, String message) throws McTestException {
        ServerPlayer player = requireOnline(name);
        requireServer().getPlayerList().broadcastChatMessage(
                PlayerChatMessage.unsigned(player.getUUID(), message), player,
                ChatType.bind(ChatType.CHAT, player));
    }

    /** Runs a command as the fake player (its own permission level, not console). */
    public void actCommand(String name, String command) throws McTestException {
        ServerPlayer player = requireOnline(name);
        requireServer().getCommands().performPrefixedCommand(player.createCommandSourceStack(), command);
    }

    /** Teleports the fake player within/into the named world (default: its current world). */
    public void actTeleport(String name, String worldName, double x, double y, double z)
            throws McTestException {
        ServerPlayer player = requireOnline(name);
        ServerLevel world = worldName == null || worldName.isEmpty()
                ? player.serverLevel() : resolveWorld(worldName);
        if (world == null) {
            throw McTestException.worldNotReady("World not loaded: " + worldName);
        }
        player.teleportTo(world, x, y, z, player.getYRot(), player.getXRot());
    }

    /** Points the fake player's eyes at a position. */
    public void actLookAt(String name, double x, double y, double z) throws McTestException {
        ServerPlayer player = requireOnline(name);
        player.lookAt(EntityAnchorArgument.Anchor.EYES, new Vec3(x, y, z));
    }

    /** The vanilla attack sequence (Forge fires AttackEntityEvent inside Player.attack). */
    public String actAttackEntity(String name, String targetRef) throws McTestException {
        ServerPlayer player = requireOnline(name);
        Entity target = requireEntity(targetRef);
        player.attack(target);
        return "attacked";
    }

    /** The vanilla interact sequence (Forge fires EntityInteract inside Player.interactOn). */
    public String actInteractEntity(String name, String targetRef) throws McTestException {
        ServerPlayer player = requireOnline(name);
        Entity target = requireEntity(targetRef);
        InteractionResult vanilla = player.interactOn(target, InteractionHand.MAIN_HAND);
        if (vanilla.consumesAction()) {
            player.swing(InteractionHand.MAIN_HAND, true);
        }
        return "vanilla:" + vanilla;
    }

    /** Right-clicks the block at (x, y, z) with the main hand (fires RightClickBlock via the game mode). */
    public String actInteractBlock(String name, int x, int y, int z) throws McTestException {
        ServerPlayer player = requireOnline(name);
        BlockPos pos = new BlockPos(x, y, z);
        BlockHitResult hit = new BlockHitResult(Vec3.atCenterOf(pos), Direction.UP, pos, false);
        InteractionResult result = player.gameMode.useItemOn(player, player.serverLevel(),
                player.getItemInHand(InteractionHand.MAIN_HAND), InteractionHand.MAIN_HAND, hit);
        return result.toString();
    }

    /**
     * Right-clicks whatever block the fake player is facing (≤5 blocks, no fluids) — the
     * {@code /actor <name> useblock} convenience (spec/42), with the REAL raycast hit (face + point).
     */
    public String actUseBlockFacing(String name) throws McTestException {
        ServerPlayer player = requireOnline(name);
        HitResult hit = player.pick(5.0, 0.0f, false);
        if (hit.getType() != HitResult.Type.BLOCK || !(hit instanceof BlockHitResult blockHit)) {
            throw McTestException.invalidParams("No block within reach of " + name);
        }
        InteractionResult result = player.gameMode.useItemOn(player, player.serverLevel(),
                player.getItemInHand(InteractionHand.MAIN_HAND), InteractionHand.MAIN_HAND, blockHit);
        return result.toString();
    }

    /**
     * Clicks a slot of the fake player's open server-side container menu. {@code button} and
     * {@code mode} are the vanilla click protocol's own two parameters (mouse button, and the
     * canonical click-type name from {@code Menus.clickMode}), so a right-click or a shift-click on a
     * modded GUI is expressible.
     */
    public void actClickMenuSlot(String name, int slot, int button, String mode) throws McTestException {
        ServerPlayer player = requireOnline(name);
        if (player.containerMenu == player.inventoryMenu) {
            throw McTestException.invalidParams("clickMenuSlot: no menu open for " + name);
        }
        player.containerMenu.clicked(slot, button, clickType(mode), player);
    }

    /**
     * The canonical click-mode name to this runtime's mapped constant. Resolved by a switch on
     * purpose: enum constant names are remapped like any other field, so {@code valueOf} on a
     * mapping-neutral string would work in dev and fail on a real server.
     */
    private ClickType clickType(String mode) throws McTestException {
        switch (mode == null ? "PICKUP" : mode) {
            case "PICKUP":
                return ClickType.PICKUP;
            case "QUICK_MOVE":
                return ClickType.QUICK_MOVE;
            case "SWAP":
                return ClickType.SWAP;
            case "CLONE":
                return ClickType.CLONE;
            case "THROW":
                return ClickType.THROW;
            case "PICKUP_ALL":
                return ClickType.PICKUP_ALL;
            default:
                throw McTestException.invalidParams("Unknown click mode: " + mode);
        }
    }

    /**
     * The menu the fake player has open, flattened to plain text (spec/42 "click text"). The player's
     * own inventory screen is NOT a menu — it is what "no menu open" means — matching
     * {@link #actClickMenuSlot}'s guard exactly, so a text click can never silently address the
     * inventory the player is carrying.
     */
    public MenuView menuOf(String name) throws McTestException {
        ServerPlayer player = requireOnline(name);
        AbstractContainerMenu menu = player.containerMenu;
        if (menu == null || menu == player.inventoryMenu) {
            return MenuView.CLOSED;
        }
        Container own = player.getInventory();
        List<MenuView.Slot> rows = new ArrayList<>();
        for (int i = 0; i < menu.slots.size(); i++) {
            Slot slot = menu.slots.get(i);
            ItemStack stack = slot.getItem();
            if (stack.isEmpty()) {
                continue;
            }
            rows.add(new MenuView.Slot(i, BuiltInRegistries.ITEM.getKey(stack.getItem()).toString(),
                    stack.getCount(), stack.getHoverName().getString(), loreOf(stack),
                    slot.container == own));
        }
        return MenuView.of(menuType(menu), null, menu.slots.size(), rows);
    }

    /**
     * Lore lines as plain text. 1.20.1 predates data components: lore is JSON text in the item's
     * {@code display.Lore} NBT list.
     */
    private List<String> loreOf(ItemStack stack) {
        List<String> lines = new ArrayList<>();
        CompoundTag display = stack.getTagElement("display");
        if (display == null || !display.contains("Lore", Tag.TAG_LIST)) {
            return lines;
        }
        ListTag lore = display.getList("Lore", Tag.TAG_STRING);
        for (int i = 0; i < lore.size(); i++) {
            try {
                Component line = Component.Serializer.fromJson(lore.getString(i));
                lines.add(line == null ? lore.getString(i) : line.getString());
            } catch (RuntimeException e) {
                // A malformed lore line is the item's problem, not a reason to fail the read.
                lines.add(lore.getString(i));
            }
        }
        return lines;
    }

    /**
     * A menu's registry id, or the menu's class name when it has none. Modded GUIs are the case that
     * matters and their class names survive remapping, so this is a real identity to look at.
     */
    private String menuType(AbstractContainerMenu menu) {
        try {
            ResourceLocation id = BuiltInRegistries.MENU.getKey(menu.getType());
            if (id != null) {
                return id.toString();
            }
        } catch (RuntimeException ignored) {
            // getType() throws for menus that never registered one (most modded GUIs).
        }
        return menu.getClass().getSimpleName();
    }


    /** Inserts {@code count} of {@code itemId} into the fake player's inventory (overflow drops at its feet). */
    public void actGive(String name, String itemId, int count) throws McTestException {
        ServerPlayer player = requireOnline(name);
        ItemStack stack = new ItemStack(requireItem(itemId), Math.max(1, count));
        player.getInventory().add(stack);
        if (!stack.isEmpty()) {
            player.drop(stack, false, false);
        }
        player.containerMenu.broadcastChanges();
    }

    /** Puts {@code itemId} in the main hand; null/empty clears it. */
    public void actHold(String name, String itemId) throws McTestException {
        ServerPlayer player = requireOnline(name);
        if (itemId == null || itemId.isEmpty()) {
            player.setItemInHand(InteractionHand.MAIN_HAND, ItemStack.EMPTY);
        } else {
            player.setItemInHand(InteractionHand.MAIN_HAND, new ItemStack(requireItem(itemId), 1));
        }
    }

    public void actSneak(String name, boolean sneaking) throws McTestException {
        requireOnline(name).setShiftKeyDown(sneaking);
    }

    public void actSprint(String name, boolean sprinting) throws McTestException {
        requireOnline(name).setSprinting(sprinting);
    }

    public void actSetGameMode(String name, String gameMode) throws McTestException {
        ServerPlayer player = requireOnline(name);
        GameType mode = GameType.byName(gameMode, null);
        if (mode == null) {
            throw McTestException.invalidParams("Unknown gameMode: " + gameMode);
        }
        player.setGameMode(mode);
    }

    /**
     * Live state of one fake player for {@code player.list} / {@code /actor list} (spec/42).
     * {@code online:false} means the roster remembers it but no entity is in-world.
     */
    public ActorState fakePlayerState(String name) {
        ServerPlayer player = onlinePlayer(name);
        ActorState state = new ActorState();
        if (player == null) {
            state.online = false;
            return state;
        }
        state.online = true;
        Vec3 pos = player.position();
        state.x = pos.x;
        state.y = pos.y;
        state.z = pos.z;
        state.dimension = worldId(player.serverLevel());
        state.gameMode = player.gameMode.getGameModeForPlayer().getName();
        state.health = player.getHealth();
        return state;
    }

    private MinecraftServer requireServer() throws McTestException {
        MinecraftServer s = this.server;
        if (s == null) {
            throw McTestException.internal("No server available");
        }
        return s;
    }

    private ServerPlayer requireOnline(String name) throws McTestException {
        ServerPlayer player = onlinePlayer(name);
        if (player == null) {
            throw McTestException.invalidParams("Fake player not online: " + name);
        }
        return player;
    }

    /**
     * Resolves an act verb's {@code target}: an entity UUID, or an online player's NAME (nothing
     * carries a spawn's returned uuid between steps, so the name form is what makes "the actor
     * right-clicks the other player" authorable — mirrors the fabric agent).
     */
    private Entity requireEntity(String target) throws McTestException {
        MinecraftServer s = requireServer();
        java.util.UUID id;
        try {
            id = java.util.UUID.fromString(target);
        } catch (IllegalArgumentException e) {
            ServerPlayer player = s.getPlayerList().getPlayerByName(target);
            if (player != null) {
                return player;
            }
            throw McTestException.invalidParams(
                    "Bad entity target '" + target + "': not a uuid, and no online player by that name");
        }
        for (ServerLevel level : s.getAllLevels()) {
            Entity entity = level.getEntity(id);
            if (entity != null) {
                return entity;
            }
        }
        throw McTestException.invalidParams("No loaded entity with uuid " + target);
    }

    private Item requireItem(String itemId) throws McTestException {
        ResourceLocation id = ResourceLocation.tryParse(itemId);
        Item item = id != null ? BuiltInRegistries.ITEM.get(id) : null;
        if (item == null || item == Items.AIR) {
            throw McTestException.invalidParams("Unknown item: " + itemId);
        }
        return item;
    }

    /**
     * The network-driven half of a player tick never runs for a discard connection (the server's
     * connection listener never saw it), so the entity tick drives it — the Carpet fake-player pattern.
     */
    private static final class FakeAvatar extends ServerPlayer {
        FakeAvatar(MinecraftServer server, ServerLevel level, GameProfile profile) {
            // 1.20.1: no ClientInformation param yet.
            super(server, level, profile);
        }

        @Override
        public void tick() {
            if (this.getServer() != null && this.getServer().getTickCount() % 10 == 0) {
                this.connection.resetPosition();
                this.serverLevel().getChunkSource().move(this);
            }
            super.tick();
            this.doTick();
        }
    }

    /**
     * A serverbound {@link Connection} that swallows every outbound packet without erroring —
     * mods send packets at join and each one must vanish silently.
     */
    private static final class DiscardingConnection extends Connection {
        DiscardingConnection() {
            super(PacketFlow.SERVERBOUND);
        }

        @Override
        public void send(Packet<?> packet) {
        }

        @Override
        public void send(Packet<?> packet, PacketSendListener listener) {
        }

        // 1.20.1 has only the two send overloads (the flush variant is 1.20.2+).
    }

    // --- private helpers (Mojmap-mapped; confined to this file) ---

    private ServerPlayer onlinePlayer(String name) {
        MinecraftServer s = this.server;
        // Mojmap: MinecraftServer#getPlayerList().getPlayerByName(name).
        return s != null ? s.getPlayerList().getPlayerByName(name) : null;
    }

    private ServerPlayer playerByUuid(java.util.UUID uuid) {
        MinecraftServer s = this.server;
        // Mojmap: PlayerList#getPlayer(UUID).
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
        // Mojmap: GameRules.visitGameRuleTypes(Visitor) walks every (Key, Type).
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
        // Mojmap: Property#getName(T) renders the value's serialized name (Yarn's analogue is
        // Property#name(T)).
        return property.getName(state.getValue(property));
    }

    private static String biomeId(ServerLevel world, BlockPos pos) {
        // Mojmap: Level#getBiome(BlockPos) → Holder<Biome>; unwrapKey() yields the registry key.
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
        // Mojmap: Entity#getTags() is the command-tag set.
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

    /** Live fake-player state for {@code player.list} (spec/42); fields valid only when online. */
    public static final class ActorState {
        public boolean online;
        public double x;
        public double y;
        public double z;
        public String dimension;
        public String gameMode;
        public double health;
    }

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
