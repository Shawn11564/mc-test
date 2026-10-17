package io.mctest.agent.serverfabric.mappings;

import io.mctest.agent.core.McTestException;
import io.mctest.agent.core.MenuView;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.ServiceLoader;
import java.util.concurrent.Callable;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.WeakHashMap;
import java.util.function.BiConsumer;
import com.mojang.authlib.GameProfile;
import io.netty.channel.embedded.EmbeddedChannel;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.fabricmc.fabric.api.event.player.AttackEntityCallback;
import net.fabricmc.fabric.api.event.player.UseEntityCallback;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.command.argument.EntityAnchorArgumentType;
import net.minecraft.entity.Entity;
import net.minecraft.inventory.Inventory;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.network.ClientConnection;
import net.minecraft.network.DisconnectionInfo;
import net.minecraft.network.NetworkSide;
import net.minecraft.network.PacketCallbacks;
import net.minecraft.network.message.MessageType;
import net.minecraft.network.message.SignedMessage;
import net.minecraft.network.packet.Packet;
import net.minecraft.network.packet.s2c.play.BundleS2CPacket;
import net.minecraft.network.packet.s2c.play.GameMessageS2CPacket;
import net.minecraft.network.packet.s2c.play.OverlayMessageS2CPacket;
import net.minecraft.network.packet.s2c.play.SubtitleS2CPacket;
import net.minecraft.network.packet.s2c.play.TitleS2CPacket;
import net.minecraft.server.network.ServerPlayNetworkHandler;
import net.minecraft.network.packet.c2s.common.SyncedClientOptions;
import net.minecraft.registry.Registries;
import net.minecraft.registry.RegistryKey;
import net.minecraft.registry.RegistryKeys;
import net.minecraft.component.DataComponentTypes;
import net.minecraft.component.type.LoreComponent;
import net.minecraft.screen.ScreenHandler;
import net.minecraft.screen.slot.Slot;
import net.minecraft.screen.slot.SlotActionType;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.command.ServerCommandSource;
import net.minecraft.server.network.ConnectedClientData;
import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.server.world.ServerWorld;
import net.minecraft.state.property.Property;
import net.minecraft.text.Text;
import net.minecraft.util.ActionResult;
import net.minecraft.util.Hand;
import net.minecraft.util.Identifier;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.hit.HitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Vec3d;
import net.minecraft.world.GameMode;
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
 * for entities, {@link GameRules}/{@code setTimeOfDay}/{@code setWeather} for fixtures, and — unlike
 * the Carpet-backed Bukkit agent — <b>native</b> fake players: a real {@link ServerPlayerEntity}
 * joined behind a discard connection, no Carpet mod required (spec/41 tier 2).
 * The MCTP dispatch loop runs on a Java-WebSocket worker thread, so every game access bounces
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
    private volatile ActorCommandObserver actorCommandObserver;
    private volatile BiConsumer<String, String> toldListener;
    private volatile Swaps swaps;
    /** The network handlers behind this agent's discard connections (by identity; a respawn keeps its handler). */
    private final java.util.Set<ServerPlayNetworkHandler> fakeHandlers =
            Collections.synchronizedSet(Collections.newSetFromMap(new WeakHashMap<>()));

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
        // A player behind a discard connection that isn't a FakeAvatar (an actor respawned after dying while
        // someone controlled it) still needs the network-side half of its tick.
        ServerTickEvents.END_SERVER_TICK.register(this::pumpPlainActors);
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

    /**
     * @return true if a mod with the given id is loaded (F5 loader-provided {@code mod.loaded} built-in).
     * Backs the {@link io.mctest.agent.core.LoaderPresence} the {@code PluginStateProbe} passes, so a
     * downloaded third-party mod (no SUT SPI) can be asserted present via {@code truth.assertPluginState}.
     */
    public boolean isModLoaded(String id) {
        return id != null && FabricLoader.getInstance().isModLoaded(id);
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

    /** Sets a gamerule by name. Routed through the server's /gamerule command (robust across types). */
    public void setGameRule(String worldName, String ruleName, Object value) throws McTestException {
        ServerWorld world = resolveWorld(worldName);
        if (world == null) {
            throw McTestException.fixtureFailed("World not loaded for gamerule");
        }
        if (findGameRuleKey(ruleName) == null) {
            throw McTestException.fixtureFailed("Unknown gamerule: " + ruleName);
        }
        // In Yarn 1.21.x GameRules.Rule<T>.setValue takes another Rule<T> (CRTP), NOT a raw value, so
        // set via the server's /gamerule command — robust across rule types (boolean/int) and MC
        // versions. Gamerules are server-wide (stored on the overworld); worldName only gates "loaded".
        dispatchConsoleCommand("gamerule " + ruleName + " " + value);
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

    // --- console command dispatch (fixtures; also usable for Carpet-style backends) ---

    /**
     * Dispatches one console command through the server command manager with full permissions
     * (mirrors the Bukkit agent's {@code Bukkit.dispatchCommand(consoleSender, …)}).
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

    /** @return the online player's UUID, or null if not online. */
    public String onlinePlayerUuid(String name) {
        ServerPlayerEntity player = onlinePlayer(name);
        return player != null ? player.getUuid().toString() : null;
    }

    // --- native fake players (spec/41 tier 2: a real ServerPlayerEntity the agent owns) ---
    //
    // The "player" is a real ServerPlayerEntity joined through PlayerManager.onPlayerConnect behind a
    // ClientConnection that discards every outbound packet (activated via an EmbeddedChannel so the
    // connection looks open without a socket). Every join/leave/interact hook fires exactly as for a
    // human; no Carpet mod is required. Action verbs run the same sequence the vanilla packet handler
    // runs — the Fabric callback first, then the vanilla method — so SUT mods listening at either
    // level see a faithful interaction. Identity is the deterministic offline UUID, stable across
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
        if (s.getPlayerManager().getPlayer(id) != null) {
            throw McTestException.invalidParams("Fake player already online: " + name);
        }
        GameMode mode = null;
        if (gameMode != null && !gameMode.isEmpty()) {
            mode = GameMode.byName(gameMode, null);
            if (mode == null) {
                throw McTestException.invalidParams("Unknown gameMode: " + gameMode);
            }
        }
        GameProfile profile = new GameProfile(id, name);
        FakeAvatar player = new FakeAvatar(this, s, s.getOverworld(), profile);
        DiscardingConnection connection = new DiscardingConnection(this, name);
        // Activating an EmbeddedChannel with the connection as its handler runs channelActive, which
        // adopts the channel — the supported way to make an unregistered connection look connected.
        new EmbeddedChannel(connection);
        try {
            s.getPlayerManager().onPlayerConnect(connection, player,
                    ConnectedClientData.createDefault(profile, false));
        } catch (Exception e) {
            throw McTestException.internal("Native fake-player join failed for '" + name + "': "
                    + describe(e));
        }
        fakeHandlers.add(player.networkHandler);
        if (x != null && y != null && z != null) {
            player.teleport(s.getOverworld(), x, y, z, player.getYaw(), player.getPitch());
        }
        if (mode != null) {
            player.changeGameMode(mode);
        }
        return id.toString();
    }

    /**
     * Disconnects a native fake player through the real leave path, so leave events fire.
     *
     * @return true if the player was online and is now disconnected; false if not online.
     */
    public boolean despawnFakePlayer(String name) {
        ServerPlayerEntity player = onlinePlayer(name);
        if (player == null || !isActorPlayer(player)) {
            return false; // never disconnect a real player (or someone playing as this actor)
        }
        if (!player.isDisconnected()) {
            player.networkHandler.onDisconnected(new DisconnectionInfo(Text.literal("mc-test despawn")));
        }
        return true;
    }

    /** Broadcasts an unsigned player chat message from the fake player. */
    public void actChat(String name, String message) throws McTestException {
        ServerPlayerEntity player = requireOnline(name);
        requireServer().getPlayerManager().broadcast(
                SignedMessage.ofUnsigned(player.getUuid(), message), player,
                MessageType.params(MessageType.CHAT, player));
    }

    /** Runs a command as the fake player (its own permission level, not console). */
    public void actCommand(String name, String command) throws McTestException {
        ServerPlayerEntity player = requireOnline(name);
        ServerCommandSource source = player.getCommandSource();
        ActorCommandObserver observer = actorCommandObserver;
        if (observer != null) {
            source = observer.started(name, command).watch(source, player, null);
        }
        requireServer().getCommandManager().executeWithPrefix(source, command);
    }

    /** Told about each command an actor is made to run, so a macro can tell whether it worked. */
    public interface ActorCommandObserver {
        CommandOutcome started(String actor, String command);
    }

    /** Set while a macro step runs ({@link MacroCommands}); null otherwise. */
    public void setActorCommandObserver(ActorCommandObserver observer) {
        this.actorCommandObserver = observer;
    }

    /** Hears every message an actor is told (actor name, plain text): chat, action bar, titles; for macro waits. */
    public void setToldListener(BiConsumer<String, String> listener) {
        this.toldListener = listener;
    }

    /**
     * What {@link ActorControl} tells the facade about the players it has swapped: while someone controls an
     * actor, their own body sits behind the actor's discard connection and the actor behind theirs.
     */
    public interface Swaps {
        /** A real player's body, parked behind an actor's connection while they control the actor. */
        boolean isParked(ServerPlayerEntity player);

        /** Who is controlling the actor {@code name}, or null. */
        String controllerOf(String name);
    }

    public void setSwaps(Swaps swaps) {
        this.swaps = swaps;
    }

    /** Whether {@code player} is behind one of this agent's discard connections (an actor, or a parked body). */
    boolean isDiscarding(ServerPlayerEntity player) {
        return fakeHandlers.contains(player.networkHandler);
    }

    /** One of this agent's actors: behind a discard connection, and not someone's parked body. */
    private boolean isActorPlayer(ServerPlayerEntity player) {
        Swaps s = swaps;
        return isDiscarding(player) && (s == null || !s.isParked(player));
    }

    /** Messages a discard connection carries, for {@link #setToldListener}. */
    void told(String who, Packet<?> packet) {
        BiConsumer<String, String> listener = toldListener;
        if (listener == null) {
            return;
        }
        if (packet instanceof BundleS2CPacket bundle) {
            for (Packet<?> part : bundle.getPackets()) {
                told(who, part);
            }
            return;
        }
        Text text;
        if (packet instanceof GameMessageS2CPacket chat) {
            text = chat.content();
        } else if (packet instanceof OverlayMessageS2CPacket bar) {
            text = bar.text();
        } else if (packet instanceof TitleS2CPacket title) {
            text = title.text();
        } else if (packet instanceof SubtitleS2CPacket subtitle) {
            text = subtitle.text();
        } else {
            return;
        }
        listener.accept(who, text.getString());
    }

    /** The network-side tick for actors that aren't FakeAvatars (see installServerLifecycle). */
    private void pumpPlainActors(MinecraftServer s) {
        for (ServerPlayerEntity player : new ArrayList<>(s.getPlayerManager().getPlayerList())) {
            if (player instanceof FakeAvatar || !isActorPlayer(player)) {
                continue;
            }
            if (s.getTicks() % 10 == 0) {
                player.networkHandler.syncWithPlayerPosition();
                player.getServerWorld().getChunkManager().updatePosition(player);
            }
            player.playerTick();
        }
    }

    /** Teleports the fake player within/into the named world (default: current rules per resolveWorld). */
    public void actTeleport(String name, String worldName, double x, double y, double z)
            throws McTestException {
        ServerPlayerEntity player = requireOnline(name);
        ServerWorld world = worldName == null || worldName.isEmpty()
                ? player.getServerWorld() : resolveWorld(worldName);
        if (world == null) {
            throw McTestException.worldNotReady("World not loaded: " + worldName);
        }
        player.teleport(world, x, y, z, player.getYaw(), player.getPitch());
    }

    /** Points the fake player's eyes at a position. */
    public void actLookAt(String name, double x, double y, double z) throws McTestException {
        ServerPlayerEntity player = requireOnline(name);
        player.lookAt(EntityAnchorArgumentType.EntityAnchor.EYES, new Vec3d(x, y, z));
    }

    /**
     * The vanilla attack sequence: Fabric's {@code AttackEntityCallback} first (it lives in the packet
     * handler), then {@code PlayerEntity.attack} unless the event consumed it.
     */
    public String actAttackEntity(String name, String targetUuid) throws McTestException {
        ServerPlayerEntity player = requireOnline(name);
        Entity target = requireEntity(targetUuid);
        ActionResult event = AttackEntityCallback.EVENT.invoker()
                .interact(player, player.getWorld(), Hand.MAIN_HAND, target, null);
        if (event != ActionResult.PASS) {
            return "event:" + event;
        }
        player.attack(target);
        return "attacked";
    }

    /**
     * The vanilla interact sequence: Fabric's {@code UseEntityCallback} first, then
     * {@code PlayerEntity.interact} unless the event consumed it.
     */
    public String actInteractEntity(String name, String targetUuid) throws McTestException {
        ServerPlayerEntity player = requireOnline(name);
        Entity target = requireEntity(targetUuid);
        ActionResult event = UseEntityCallback.EVENT.invoker()
                .interact(player, player.getWorld(), Hand.MAIN_HAND, target, null);
        if (event != ActionResult.PASS) {
            return "event:" + event;
        }
        ActionResult vanilla = player.interact(target, Hand.MAIN_HAND);
        if (vanilla.isAccepted()) {
            player.swingHand(Hand.MAIN_HAND, true);
        }
        return "vanilla:" + vanilla;
    }

    /** Right-clicks the block at (x, y, z) with the main hand (fires the Fabric UseBlockCallback via the interaction manager). */
    public String actInteractBlock(String name, int x, int y, int z) throws McTestException {
        ServerPlayerEntity player = requireOnline(name);
        BlockPos pos = new BlockPos(x, y, z);
        BlockHitResult hit = new BlockHitResult(Vec3d.ofCenter(pos), Direction.UP, pos, false);
        ActionResult result = player.interactionManager.interactBlock(player, player.getServerWorld(),
                player.getStackInHand(Hand.MAIN_HAND), Hand.MAIN_HAND, hit);
        return result.toString();
    }

    /**
     * Clicks a slot of the fake player's open server-side screen handler. {@code button} and
     * {@code mode} are the vanilla click protocol's own two parameters (mouse button, and the
     * canonical click-type name from {@code Menus.clickMode}), so a right-click or a shift-click on a
     * modded GUI is expressible.
     */
    public void actClickMenuSlot(String name, int slot, int button, String mode) throws McTestException {
        ServerPlayerEntity player = requireOnline(name);
        if (player.currentScreenHandler == player.playerScreenHandler) {
            throw McTestException.invalidParams("clickMenuSlot: no menu open for " + name);
        }
        player.currentScreenHandler.onSlotClick(slot, button, slotAction(mode), player);
    }

    /**
     * The canonical click-mode name to this runtime's mapped constant. Resolved by a switch on
     * purpose: enum constant names are remapped like any other field, so {@code valueOf} on a
     * mapping-neutral string would work in dev and fail on a real server.
     */
    private SlotActionType slotAction(String mode) throws McTestException {
        switch (mode == null ? "PICKUP" : mode) {
            case "PICKUP":
                return SlotActionType.PICKUP;
            case "QUICK_MOVE":
                return SlotActionType.QUICK_MOVE;
            case "SWAP":
                return SlotActionType.SWAP;
            case "CLONE":
                return SlotActionType.CLONE;
            case "THROW":
                return SlotActionType.THROW;
            case "PICKUP_ALL":
                return SlotActionType.PICKUP_ALL;
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
        ServerPlayerEntity player = requireOnline(name);
        ScreenHandler handler = player.currentScreenHandler;
        if (handler == null || handler == player.playerScreenHandler) {
            return MenuView.CLOSED;
        }
        Inventory own = player.getInventory();
        List<MenuView.Slot> rows = new ArrayList<>();
        for (int i = 0; i < handler.slots.size(); i++) {
            Slot slot = handler.slots.get(i);
            ItemStack stack = slot.getStack();
            if (stack.isEmpty()) {
                continue;
            }
            rows.add(new MenuView.Slot(i, Registries.ITEM.getId(stack.getItem()).toString(),
                    stack.getCount(), stack.getName().getString(), loreOf(stack), slot.inventory == own));
        }
        return MenuView.of(menuType(handler), null, handler.slots.size(), rows);
    }

    /** Lore lines as plain text; 1.20.5+ keeps them in the LORE data component. */
    private List<String> loreOf(ItemStack stack) {
        List<String> lines = new ArrayList<>();
        LoreComponent lore = stack.get(DataComponentTypes.LORE);
        if (lore != null) {
            for (Text line : lore.lines()) {
                lines.add(line.getString());
            }
        }
        return lines;
    }

    /**
     * A menu's registry id, or the handler's class name when it has none. Modded GUIs are the case
     * that matters and their class names survive remapping, so this is a real identity to look at.
     */
    private String menuType(ScreenHandler handler) {
        try {
            Identifier id = Registries.SCREEN_HANDLER.getId(handler.getType());
            if (id != null) {
                return id.toString();
            }
        } catch (RuntimeException ignored) {
            // getType() throws for handlers that never registered one (most modded menus).
        }
        return handler.getClass().getSimpleName();
    }

    /** Inserts {@code count} of {@code itemId} into the fake player's inventory (overflow drops at its feet). */
    public void actGive(String name, String itemId, int count) throws McTestException {
        ServerPlayerEntity player = requireOnline(name);
        ItemStack stack = new ItemStack(requireItem(itemId), Math.max(1, count));
        player.getInventory().insertStack(stack);
        if (!stack.isEmpty()) {
            player.dropItem(stack, false, false);
        }
        player.currentScreenHandler.sendContentUpdates();
    }

    /** Puts {@code itemId} in the main hand; null/empty clears it. */
    public void actHold(String name, String itemId) throws McTestException {
        ServerPlayerEntity player = requireOnline(name);
        if (itemId == null || itemId.isEmpty()) {
            player.setStackInHand(Hand.MAIN_HAND, ItemStack.EMPTY);
        } else {
            player.setStackInHand(Hand.MAIN_HAND, new ItemStack(requireItem(itemId), 1));
        }
    }

    public void actSneak(String name, boolean sneaking) throws McTestException {
        requireOnline(name).setSneaking(sneaking);
    }

    public void actSprint(String name, boolean sprinting) throws McTestException {
        requireOnline(name).setSprinting(sprinting);
    }

    public void actSetGameMode(String name, String gameMode) throws McTestException {
        ServerPlayerEntity player = requireOnline(name);
        GameMode mode = GameMode.byName(gameMode, null);
        if (mode == null) {
            throw McTestException.invalidParams("Unknown gameMode: " + gameMode);
        }
        player.changeGameMode(mode);
    }

    /**
     * Right-clicks whatever block the fake player is facing (≤5 blocks, no fluids) — the
     * {@code /actor <name> useblock} convenience (spec/42). Same interaction-manager path as
     * {@link #actInteractBlock}, but with the REAL raycast hit (face + exact point), so
     * orientation-sensitive blocks behave as for a human.
     */
    public String actUseBlockFacing(String name) throws McTestException {
        ServerPlayerEntity player = requireOnline(name);
        HitResult hit = player.raycast(5.0, 0.0f, false);
        if (hit.getType() != HitResult.Type.BLOCK || !(hit instanceof BlockHitResult blockHit)) {
            throw McTestException.invalidParams("No block within reach of " + name);
        }
        ActionResult result = player.interactionManager.interactBlock(player, player.getServerWorld(),
                player.getStackInHand(Hand.MAIN_HAND), Hand.MAIN_HAND, blockHit);
        return result.toString();
    }

    /**
     * Live state of one fake player for {@code player.list} / {@code /actor list} (spec/42).
     * {@code online:false} means the roster remembers it but no entity is in-world (e.g. a
     * persistent actor kicked by something else); everything else is populated only when online.
     */
    public ActorState fakePlayerState(String name) {
        ServerPlayerEntity player = onlinePlayer(name);
        ActorState state = new ActorState();
        if (player == null) {
            state.online = false;
            return state;
        }
        state.online = true;
        Vec3d pos = player.getPos();
        state.x = pos.x;
        state.y = pos.y;
        state.z = pos.z;
        state.dimension = worldId(player.getServerWorld());
        state.gameMode = player.interactionManager.getGameMode().getName();
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

    private ServerPlayerEntity requireOnline(String name) throws McTestException {
        ServerPlayerEntity player = onlinePlayer(name);
        if (player == null) {
            throw McTestException.invalidParams("Fake player not online: " + name);
        }
        Swaps s = swaps;
        String controller = s == null ? null : s.controllerOf(name);
        if (controller != null) {
            throw McTestException.invalidParams(name + " is being controlled by " + controller
                    + " (/actor back hands it back)");
        }
        if (!isActorPlayer(player)) {
            // The roster goes by name: a real player who took a departed actor's name is never driven.
            throw McTestException.invalidParams(name + " is a real player now, not an actor");
        }
        return player;
    }

    /**
     * Resolves an act verb's {@code target}: an entity UUID, or — because the only entities a step
     * file can name deterministically are players — an online player's NAME. Without the name form
     * a step file could not target the bot or another fake at all: nothing carries a spawn's returned
     * uuid from one step to the next, and hand-computing the offline uuid is not authoring.
     */
    private Entity requireEntity(String target) throws McTestException {
        MinecraftServer s = requireServer();
        java.util.UUID id;
        try {
            id = java.util.UUID.fromString(target);
        } catch (IllegalArgumentException e) {
            ServerPlayerEntity player = s.getPlayerManager().getPlayer(target);
            if (player != null) {
                return player;
            }
            throw McTestException.invalidParams(
                    "Bad entity target '" + target + "': not a uuid, and no online player by that name");
        }
        for (ServerWorld world : s.getWorlds()) {
            Entity entity = world.getEntity(id);
            if (entity != null) {
                return entity;
            }
        }
        throw McTestException.invalidParams("No loaded entity with uuid " + target);
    }

    private Item requireItem(String itemId) throws McTestException {
        Identifier id = Identifier.tryParse(itemId);
        Item item = id != null ? Registries.ITEM.get(id) : null;
        if (item == null || item == net.minecraft.item.Items.AIR) {
            throw McTestException.invalidParams("Unknown item: " + itemId);
        }
        return item;
    }

    /**
     * The network-driven half of a player tick never runs for a discard connection (the server's
     * connection listener never saw it), so the entity tick drives it — the Carpet fake-player pattern.
     */
    private static final class FakeAvatar extends ServerPlayerEntity {
        private final Names names;

        FakeAvatar(Names names, MinecraftServer server, ServerWorld world, GameProfile profile) {
            super(server, world, profile, SyncedClientOptions.createDefault());
            this.names = names;
        }

        @Override
        public void tick() {
            // Only behind its own discard connection: while someone controls it, their real connection ticks it.
            boolean discarding = names.isDiscarding(this);
            if (discarding && this.getServer() != null && this.getServer().getTicks() % 10 == 0) {
                this.networkHandler.syncWithPlayerPosition();
                this.getServerWorld().getChunkManager().updatePosition(this);
            }
            super.tick();
            if (discarding) {
                this.playerTick();
            }
        }
    }

    /**
     * A serverbound {@link ClientConnection} that swallows every outbound packet without erroring —
     * mods send packets at join and each one must vanish silently — after handing any message in it to the
     * told listener. A send completes as a real channel's would, so its callback runs: that's what lets
     * {@code /kick} and server shutdown disconnect an actor.
     */
    private static final class DiscardingConnection extends ClientConnection {
        private final Names names;
        private final String actor;

        DiscardingConnection(Names names, String actor) {
            super(NetworkSide.SERVERBOUND);
            this.names = names;
            this.actor = actor;
        }

        @Override
        public void send(Packet<?> packet) {
            send(packet, null, true);
        }

        @Override
        public void send(Packet<?> packet, PacketCallbacks callbacks) {
            send(packet, callbacks, true);
        }

        @Override
        public void send(Packet<?> packet, PacketCallbacks callbacks, boolean flush) {
            names.told(holder(), packet);
            if (callbacks != null) {
                callbacks.onSuccess();
            }
        }

        /** Whoever is behind this connection now: the actor, or the parked body of someone controlling it. */
        private String holder() {
            if (getPacketListener() instanceof ServerPlayNetworkHandler game && game.player != null) {
                return game.player.getGameProfile().getName();
            }
            return actor;
        }
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
