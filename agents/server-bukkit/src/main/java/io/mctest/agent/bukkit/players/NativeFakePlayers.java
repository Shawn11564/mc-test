package io.mctest.agent.bukkit.players;

import io.mctest.agent.core.McTestException;
import java.lang.reflect.Array;
import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.logging.Logger;
import org.bukkit.Bukkit;
import org.bukkit.Location;
import org.bukkit.block.Block;
import org.bukkit.block.BlockFace;
import org.bukkit.entity.Player;
import org.bukkit.event.player.PlayerInteractEntityEvent;
import org.bukkit.inventory.EquipmentSlot;
import org.bukkit.util.RayTraceResult;

/**
 * The NATIVE fake-player backend for the Bukkit agent (spec/42 Plan C): the same
 * real-player-behind-a-discard-connection pattern the fabric/forge/neoforge agents compile against
 * remapped Minecraft, done here with <b>reflection only</b> against Paper's Mojang-mapped RUNTIME
 * (1.20.5+ ships official names at runtime). This file is the module's reflective quarantine — every
 * runtime-Mojmap name lives here as a string, and NOTHING is referenced at compile time (the module
 * stays Bukkit-API-only, preserving its "no per-version remap" property).
 *
 * <p><b>Probe-gated, per PD-4 (honest skips beat false greens):</b> {@link #probe} resolves every
 * class/method/field this backend touches at plugin enable; ONE miss → the backend is absent, the
 * plugin logs exactly which symbol failed, and the capability falls back to Carpet-or-skip exactly
 * as before. Spigot and pre-1.20.5 Paper (obfuscated/Spigot-mapped runtime) fail the very first
 * lookup and thus keep today's honest skip. A Mojmap rename in a future MC version degrades to the
 * same honest skip — never a false green, never a boot crash.
 *
 * <p>Two deliberate deltas from the compiled ports:
 * <ul>
 *   <li><b>No subclasses.</b> Reflection cannot extend {@code ServerPlayer}/{@code Connection}, so
 *       (a) the discard connection is a REAL {@code Connection} adopted by an {@code EmbeddedChannel}
 *       (outbound packets buffer in the channel; {@link #tick} drains via {@code releaseOutbound()}
 *       so nothing accumulates), and (b) the FakeAvatar keep-alive override becomes a per-tick
 *       {@link #tick} pump: {@code doTick()} every tick, {@code connection.resetPosition()} +
 *       {@code chunkSource.move()} every 10 (the Carpet cadence). Dead actors are respawned through
 *       the Spigot API ({@code player.spigot().respawn()}).</li>
 *   <li><b>Bukkit events keep firing.</b> {@code useItemOn} and {@code AbstractContainerMenu.clicked}
 *       are CraftBukkit-patched to fire {@code PlayerInteractEvent}/{@code InventoryClickEvent}
 *       internally, so those reflective calls are faithful as-is; entity interaction fires
 *       {@code PlayerInteractEntityEvent} manually first (CraftBukkit fires it in the packet
 *       handler, which a fake never runs) — the same event-then-vanilla sequence the fabric agent
 *       uses for its loader callbacks.</li>
 * </ul>
 *
 * <p>All methods MUST run on the main thread (callers bounce via {@code MainThread}).
 */
public final class NativeFakePlayers {

    /** Per-actor native state the tick pump needs (the ServerPlayer itself is re-resolved by name). */
    private static final class Native {
        final Object channel; // EmbeddedChannel, drained each tick
        int ticks;

        Native(Object channel) {
            this.channel = channel;
        }
    }

    private final Logger log;
    private final Map<String, Native> natives = new LinkedHashMap<>();

    // --- resolved reflective members (all set by probe; never null afterwards) ---
    private final Method craftServerGetServer;   // CraftServer#getServer() → MinecraftServer
    private final Method playerListOf;           // MinecraftServer#getPlayerList()
    private final Method placeNewPlayer;         // PlayerList#placeNewPlayer(Connection, ServerPlayer, CommonListenerCookie)
    private final Constructor<?> connectionCtor; // Connection(PacketFlow)
    private final Object serverboundFlow;        // PacketFlow.SERVERBOUND
    private final Method cookieCreateInitial;    // CommonListenerCookie.createInitial(GameProfile, boolean)
    private final Method clientInfoDefault;      // ClientInformation.createDefault()
    private final Constructor<?> serverPlayerCtor; // ServerPlayer(MinecraftServer, ServerLevel, GameProfile, ClientInformation)
    private final Constructor<?> gameProfileCtor;  // GameProfile(UUID, String)
    private final Constructor<?> embeddedChannelCtor; // EmbeddedChannel(ChannelHandler...)
    private final Class<?> channelHandlerClass;
    private final Method releaseOutbound;        // EmbeddedChannel#releaseOutbound()
    private final Method doTick;                 // ServerPlayer#doTick()
    private final Method hasDisconnected;        // ServerPlayer#hasDisconnected()
    private final Field connectionField;         // ServerPlayer.connection (ServerGamePacketListenerImpl)
    private final Method resetPosition;          // ServerGamePacketListenerImpl#resetPosition()
    private final Method onDisconnect;           // ServerCommonPacketListenerImpl#onDisconnect(DisconnectionDetails)
    private final Constructor<?> disconnectionDetailsCtor; // DisconnectionDetails(Component)
    private final Method componentLiteral;       // Component.literal(String)
    private final Method levelGetChunkSource;    // ServerLevel#getChunkSource()
    private final Method chunkSourceMove;        // ServerChunkCache#move(ServerPlayer)
    private final Method serverPlayerLevel;      // ServerPlayer#serverLevel()
    private final Method getBukkitEntity;        // ServerPlayer#getBukkitEntity() → CraftPlayer
    private final Method interactOn;             // Player#interactOn(Entity, InteractionHand)
    private final Object mainHand;               // InteractionHand.MAIN_HAND
    private final Field containerMenuField;      // Player.containerMenu
    private final Field inventoryMenuField;      // Player.inventoryMenu
    private final Method menuClicked;            // AbstractContainerMenu#clicked(int, int, ClickType, Player)
    private final Object clickTypePickup;        // ClickType.PICKUP
    private final Class<?> clickTypeClass;       // ClickType (other constants resolved per call)
    private final Field gameModeField;           // ServerPlayer.gameMode (ServerPlayerGameMode)
    private final Method useItemOn;              // ServerPlayerGameMode#useItemOn(ServerPlayer, Level, ItemStack, InteractionHand, BlockHitResult)
    private final Method getMainHandItem;        // LivingEntity#getMainHandItem() → nms ItemStack
    private final Constructor<?> blockHitResultCtor; // BlockHitResult(Vec3, Direction, BlockPos, boolean)
    private final Constructor<?> vec3Ctor;       // Vec3(double, double, double)
    private final Constructor<?> blockPosCtor;   // BlockPos(int, int, int)
    private final Class<?> directionClass;       // Direction (enum; valueOf by BlockFace name)

    /**
     * Resolves the full reflective surface. @return the backend, or {@code null} (with the missing
     * symbol logged) when this server's runtime is not Mojang-mapped or a name moved — the caller
     * then keeps the Carpet-or-skip behavior.
     */
    public static NativeFakePlayers probe(Logger log) {
        try {
            return new NativeFakePlayers(log);
        } catch (ReflectiveOperationException | RuntimeException e) {
            log.info("Native fake-player backend unavailable (" + e.getMessage()
                    + ") — this server's runtime is not Mojang-mapped (Paper 1.20.5+), or a mapped "
                    + "name moved. Falling back to Carpet-or-skip.");
            return null;
        }
    }

    private NativeFakePlayers(Logger log) throws ReflectiveOperationException {
        this.log = log;
        Class<?> minecraftServer = Class.forName("net.minecraft.server.MinecraftServer");
        Class<?> playerList = Class.forName("net.minecraft.server.players.PlayerList");
        Class<?> connection = Class.forName("net.minecraft.network.Connection");
        Class<?> packetFlow = Class.forName("net.minecraft.network.protocol.PacketFlow");
        Class<?> cookie = Class.forName("net.minecraft.server.network.CommonListenerCookie");
        Class<?> clientInfo = Class.forName("net.minecraft.server.level.ClientInformation");
        Class<?> serverPlayer = Class.forName("net.minecraft.server.level.ServerPlayer");
        Class<?> serverLevel = Class.forName("net.minecraft.server.level.ServerLevel");
        Class<?> gameProfile = Class.forName("com.mojang.authlib.GameProfile");
        Class<?> embeddedChannel = Class.forName("io.netty.channel.embedded.EmbeddedChannel");
        this.channelHandlerClass = Class.forName("io.netty.channel.ChannelHandler");
        Class<?> gameListener = Class.forName("net.minecraft.server.network.ServerGamePacketListenerImpl");
        Class<?> commonListener = Class.forName("net.minecraft.server.network.ServerCommonPacketListenerImpl");
        Class<?> disconnectionDetails = Class.forName("net.minecraft.network.DisconnectionDetails");
        Class<?> component = Class.forName("net.minecraft.network.chat.Component");
        Class<?> chunkSource = Class.forName("net.minecraft.server.level.ServerChunkCache");
        Class<?> nmsPlayer = Class.forName("net.minecraft.world.entity.player.Player");
        Class<?> nmsEntity = Class.forName("net.minecraft.world.entity.Entity");
        Class<?> nmsLiving = Class.forName("net.minecraft.world.entity.LivingEntity");
        Class<?> interactionHand = Class.forName("net.minecraft.world.InteractionHand");
        Class<?> containerMenu = Class.forName("net.minecraft.world.inventory.AbstractContainerMenu");
        Class<?> clickType = Class.forName("net.minecraft.world.inventory.ClickType");
        Class<?> gameMode = Class.forName("net.minecraft.server.level.ServerPlayerGameMode");
        Class<?> level = Class.forName("net.minecraft.world.level.Level");
        Class<?> nmsItemStack = Class.forName("net.minecraft.world.item.ItemStack");
        Class<?> blockHitResult = Class.forName("net.minecraft.world.phys.BlockHitResult");
        Class<?> vec3 = Class.forName("net.minecraft.world.phys.Vec3");
        Class<?> blockPos = Class.forName("net.minecraft.core.BlockPos");
        Class<?> vec3i = Class.forName("net.minecraft.core.Vec3i");
        this.directionClass = Class.forName("net.minecraft.core.Direction");

        this.craftServerGetServer = Bukkit.getServer().getClass().getMethod("getServer");
        this.playerListOf = minecraftServer.getMethod("getPlayerList");
        this.placeNewPlayer = playerList.getMethod("placeNewPlayer", connection, serverPlayer, cookie);
        this.connectionCtor = connection.getConstructor(packetFlow);
        this.serverboundFlow = enumValue(packetFlow, "SERVERBOUND");
        this.cookieCreateInitial = cookie.getMethod("createInitial", gameProfile, boolean.class);
        this.clientInfoDefault = clientInfo.getMethod("createDefault");
        this.serverPlayerCtor = serverPlayer.getConstructor(minecraftServer, serverLevel, gameProfile, clientInfo);
        this.gameProfileCtor = gameProfile.getConstructor(UUID.class, String.class);
        this.embeddedChannelCtor = embeddedChannel.getConstructor(
                Array.newInstance(channelHandlerClass, 0).getClass());
        this.releaseOutbound = embeddedChannel.getMethod("releaseOutbound");
        // CraftWorld#getHandle is resolved lazily per-call (worldHandle): with `load: STARTUP` the
        // probe runs BEFORE any world exists, so there is no CraftWorld instance to look it up on.
        this.doTick = serverPlayer.getMethod("doTick");
        this.hasDisconnected = serverPlayer.getMethod("hasDisconnected");
        this.connectionField = serverPlayer.getField("connection");
        this.resetPosition = gameListener.getMethod("resetPosition");
        this.onDisconnect = commonListener.getMethod("onDisconnect", disconnectionDetails);
        this.disconnectionDetailsCtor = disconnectionDetails.getConstructor(component);
        this.componentLiteral = component.getMethod("literal", String.class);
        this.levelGetChunkSource = serverLevel.getMethod("getChunkSource");
        this.chunkSourceMove = chunkSource.getMethod("move", serverPlayer);
        this.serverPlayerLevel = serverPlayer.getMethod("serverLevel");
        this.getBukkitEntity = serverPlayer.getMethod("getBukkitEntity");
        this.interactOn = nmsPlayer.getMethod("interactOn", nmsEntity, interactionHand);
        this.mainHand = enumValue(interactionHand, "MAIN_HAND");
        this.containerMenuField = nmsPlayer.getField("containerMenu");
        this.inventoryMenuField = nmsPlayer.getField("inventoryMenu");
        this.menuClicked = containerMenu.getMethod("clicked", int.class, int.class, clickType, nmsPlayer);
        this.clickTypePickup = enumValue(clickType, "PICKUP");
        this.clickTypeClass = clickType;
        this.gameModeField = serverPlayer.getField("gameMode");
        this.useItemOn = gameMode.getMethod("useItemOn", serverPlayer, level, nmsItemStack, interactionHand, blockHitResult);
        this.getMainHandItem = nmsLiving.getMethod("getMainHandItem");
        this.blockHitResultCtor = blockHitResult.getConstructor(vec3, directionClass, blockPos, boolean.class);
        this.vec3Ctor = vec3.getConstructor(double.class, double.class, double.class);
        this.blockPosCtor = blockPos.getConstructor(int.class, int.class, int.class);
        // Non-vacuity: Vec3i is BlockPos's superclass in every Mojmap version we target; resolving it
        // proves we are looking at a Mojang-mapped runtime rather than accidentally-matching names.
        if (!vec3i.isAssignableFrom(blockPos)) {
            throw new IllegalStateException("BlockPos/Vec3i hierarchy unexpected");
        }
    }

    private static Object enumValue(Class<?> enumClass, String name) {
        for (Object c : enumClass.getEnumConstants()) {
            if (((Enum<?>) c).name().equals(name)) {
                return c;
            }
        }
        throw new IllegalStateException("No enum constant " + enumClass.getName() + "." + name);
    }

    // --- spawn / despawn / tick (main thread) ---

    /** Joins a native fake through the real join path. @return its (deterministic offline) UUID. */
    public UUID spawn(String name, Location at, org.bukkit.World fallbackWorld) throws McTestException {
        if (Bukkit.getPlayerExact(name) != null) {
            throw McTestException.invalidParams("Fake player already online: " + name);
        }
        UUID id = UUID.nameUUIDFromBytes(("OfflinePlayer:" + name)
                .getBytes(java.nio.charset.StandardCharsets.UTF_8));
        try {
            Object mc = craftServerGetServer.invoke(Bukkit.getServer());
            org.bukkit.World world = at != null && at.getWorld() != null ? at.getWorld() : fallbackWorld;
            Object levelHandle = world.getClass().getMethod("getHandle").invoke(world);
            Object profile = gameProfileCtor.newInstance(id, name);
            Object player = serverPlayerCtor.newInstance(mc, levelHandle, profile,
                    clientInfoDefault.invoke(null));
            Object conn = connectionCtor.newInstance(serverboundFlow);
            // Activating an EmbeddedChannel with the connection as its handler runs channelActive,
            // which adopts the channel — outbound packets then buffer there (drained in tick()).
            Object handlers = Array.newInstance(channelHandlerClass, 1);
            Array.set(handlers, 0, conn);
            Object channel = embeddedChannelCtor.newInstance(handlers);
            placeNewPlayer.invoke(playerListOf.invoke(mc), conn, player,
                    cookieCreateInitial.invoke(null, profile, false));
            natives.put(name, new Native(channel));
        } catch (Exception e) {
            throw McTestException.internal("Native fake-player join failed for '" + name + "': "
                    + describe(e));
        }
        return id;
    }

    /** Disconnects through the real leave path so quit events fire. @return false if not online. */
    public boolean despawn(String name) {
        natives.remove(name);
        Object player = handleByName(name);
        if (player == null) {
            return false;
        }
        try {
            if (!(Boolean) hasDisconnected.invoke(player)) {
                onDisconnect.invoke(connectionField.get(player),
                        disconnectionDetailsCtor.newInstance(componentLiteral.invoke(null, "mc-test despawn")));
            }
        } catch (Exception e) {
            log.warning("Native fake-player despawn failed for '" + name + "': " + describe(e));
            return false;
        }
        return true;
    }

    /** @return true if this backend currently owns a native entity for {@code name}. */
    public boolean owns(String name) {
        return natives.containsKey(name);
    }

    /**
     * The per-tick pump (scheduler, every tick): the network-driven half of a player tick never runs
     * for a discard connection, so drive doTick() here, plus the Carpet keep-alive cadence and the
     * outbound-buffer drain. Dead actors respawn via the Spigot API.
     */
    public void tick() {
        if (natives.isEmpty()) {
            return;
        }
        for (Map.Entry<String, Native> entry : new java.util.ArrayList<>(natives.entrySet())) {
            String name = entry.getKey();
            Native nat = entry.getValue();
            Player bukkit = Bukkit.getPlayerExact(name);
            if (bukkit == null) {
                continue; // kicked/disconnected by something else; the roster shows it offline.
            }
            try {
                if (bukkit.isDead()) {
                    bukkit.spigot().respawn();
                    continue;
                }
                Object player = playerHandle(bukkit);
                doTick.invoke(player);
                if (++nat.ticks % 10 == 0) {
                    resetPosition.invoke(connectionField.get(player));
                    chunkSourceMove.invoke(levelGetChunkSource.invoke(serverPlayerLevel.invoke(player)), player);
                    releaseOutbound.invoke(nat.channel);
                }
            } catch (Exception e) {
                log.warning("Native fake-player tick failed for '" + name + "' (removing from pump): "
                        + describe(e));
                natives.remove(name);
            }
        }
    }

    // --- the reflective interaction verbs (the Bukkit API covers the rest) ---

    /**
     * Entity interaction with the fabric agent's event-then-vanilla fidelity: CraftBukkit fires
     * {@code PlayerInteractEntityEvent} in the packet handler (which a fake never runs), so fire it
     * here first, then run the vanilla {@code interactOn}.
     */
    public String interactEntity(Player fake, org.bukkit.entity.Entity target) throws McTestException {
        PlayerInteractEntityEvent event = new PlayerInteractEntityEvent(fake, target, EquipmentSlot.HAND);
        Bukkit.getPluginManager().callEvent(event);
        if (event.isCancelled()) {
            return "event:cancelled";
        }
        try {
            Object result = interactOn.invoke(playerHandle(fake), entityHandle(target), mainHand);
            return "vanilla:" + result;
        } catch (Exception e) {
            throw McTestException.internal("interactEntity failed: " + describe(e));
        }
    }

    /**
     * Right-clicks the block at (x, y, z) via {@code ServerPlayerGameMode.useItemOn} — the
     * CraftBukkit patch inside fires {@code PlayerInteractEvent}, so plugins see the real event.
     */
    public String interactBlock(Player fake, int x, int y, int z) throws McTestException {
        return useItemOnBlock(fake, x, y, z, BlockFace.UP,
                x + 0.5, y + 0.5, z + 0.5);
    }

    /** Right-clicks whatever block the fake faces (≤5 blocks; the /actor useblock convenience). */
    public String useBlockFacing(Player fake) throws McTestException {
        RayTraceResult ray = fake.rayTraceBlocks(5.0);
        Block block = ray != null ? ray.getHitBlock() : null;
        if (block == null) {
            throw McTestException.invalidParams("No block within reach of " + fake.getName());
        }
        BlockFace face = ray.getHitBlockFace() != null ? ray.getHitBlockFace() : BlockFace.UP;
        org.bukkit.util.Vector hit = ray.getHitPosition();
        return useItemOnBlock(fake, block.getX(), block.getY(), block.getZ(), face,
                hit.getX(), hit.getY(), hit.getZ());
    }

    /** Left-clicks a slot of the fake's open menu (CraftBukkit's clicked patch fires InventoryClickEvent). */
    public void clickMenuSlot(Player fake, int slot, int button, String mode) throws McTestException {
        Object type;
        try {
            // The runtime is Mojang-mapped (the probe proved it), so ClickType's constant names are
            // the real ones and the canonical mode name resolves straight against them.
            type = mode == null || "PICKUP".equals(mode) ? clickTypePickup : enumValue(clickTypeClass, mode);
        } catch (IllegalStateException e) {
            throw McTestException.invalidParams("Unknown click mode: " + mode);
        }
        try {
            Object player = playerHandle(fake);
            Object menu = containerMenuField.get(player);
            if (menu == inventoryMenuField.get(player)) {
                throw McTestException.invalidParams("clickMenuSlot: no menu open for " + fake.getName());
            }
            menuClicked.invoke(menu, slot, button, type, player);
        } catch (McTestException e) {
            throw e;
        } catch (Exception e) {
            throw McTestException.internal("clickMenuSlot failed: " + describe(e));
        }
    }

    // --- helpers ---

    private String useItemOnBlock(Player fake, int x, int y, int z, BlockFace face,
            double hx, double hy, double hz) throws McTestException {
        Object faceDir;
        try {
            faceDir = enumValue(directionClass, face.name());
        } catch (IllegalStateException e) {
            faceDir = enumValue(directionClass, "UP"); // diagonal BlockFace from a ray edge-case
        }
        try {
            Object player = playerHandle(fake);
            Object hitResult = blockHitResultCtor.newInstance(
                    vec3Ctor.newInstance(hx, hy, hz), faceDir,
                    blockPosCtor.newInstance(x, y, z), false);
            Object result = useItemOn.invoke(gameModeField.get(player), player,
                    serverPlayerLevel.invoke(player), getMainHandItem.invoke(player), mainHand, hitResult);
            return String.valueOf(result);
        } catch (Exception e) {
            throw McTestException.internal("interactBlock failed: " + describe(e));
        }
    }

    private Object handleByName(String name) {
        Player bukkit = Bukkit.getPlayerExact(name);
        return bukkit != null ? playerHandleOrNull(bukkit) : null;
    }

    private Object playerHandle(Player bukkit) throws Exception {
        return bukkit.getClass().getMethod("getHandle").invoke(bukkit);
    }

    private Object playerHandleOrNull(Player bukkit) {
        try {
            return playerHandle(bukkit);
        } catch (Exception e) {
            return null;
        }
    }

    private Object entityHandle(org.bukkit.entity.Entity entity) throws Exception {
        return entity.getClass().getMethod("getHandle").invoke(entity);
    }

    private static String describe(Throwable t) {
        Throwable cause = t;
        while (cause.getCause() != null && (cause instanceof java.lang.reflect.InvocationTargetException
                || cause.getCause() != cause)) {
            if (cause instanceof java.lang.reflect.InvocationTargetException) {
                cause = cause.getCause();
            } else {
                break;
            }
        }
        String msg = cause.getMessage();
        return msg != null ? cause.getClass().getSimpleName() + ": " + msg
                : cause.getClass().getSimpleName();
    }
}
