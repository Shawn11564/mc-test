package io.mctest.agent.serverneoforge.mappings;

import com.mojang.logging.LogUtils;
import io.mctest.agent.core.McTestException;
import io.mctest.agent.serverneoforge.players.FakePlayerManager;
import io.netty.buffer.Unpooled;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.EnumSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import net.minecraft.ChatFormatting;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.network.DisconnectionDetails;
import net.minecraft.network.RegistryFriendlyByteBuf;
import net.minecraft.network.chat.ClickEvent;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.HoverEvent;
import net.minecraft.network.chat.MutableComponent;
import net.minecraft.network.protocol.game.ClientboundChangeDifficultyPacket;
import net.minecraft.network.protocol.game.ClientboundPlayerInfoUpdatePacket;
import net.minecraft.network.protocol.game.ClientboundRespawnPacket;
import net.minecraft.network.protocol.game.ClientboundSetDefaultSpawnPositionPacket;
import net.minecraft.network.protocol.game.ClientboundSetExperiencePacket;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.network.ServerGamePacketListenerImpl;
import net.minecraft.server.players.PlayerList;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.level.GameType;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.storage.LevelData;
import net.neoforged.neoforge.common.NeoForge;
import net.neoforged.neoforge.event.entity.player.PlayerEvent;
import net.neoforged.neoforge.event.server.ServerStoppingEvent;
import net.neoforged.neoforge.event.tick.ServerTickEvent;
import org.slf4j.Logger;

/**
 * Seeing as an actor, and playing as one, then going back to your own player (spec/42 bench actors):
 *
 * <pre>
 * /actor &lt;name&gt; view      — watch through the actor's eyes (you become a spectator until you go back)
 * /actor &lt;name&gt; control   — play as the actor: your keys, mouse, inventory, menus, chat and commands are its
 * /actor back             — back to your own player, where you left it, as you left it
 * </pre>
 *
 * <p><b>View</b> is vanilla spectating: game mode spectator, camera on the actor. Going back puts the game mode,
 * the world and the position back. Sneaking leaves the camera, as in vanilla; {@code /actor back} still returns.
 *
 * <p><b>Control</b> hands your connection to the actor's {@code ServerPlayer}, the way vanilla's respawn hands
 * a connection to a new player: the actor gets your connection and your client's entity id, the client is sent a
 * respawn into the actor's world and position, and from then on every packet your client sends drives the actor.
 * Nothing logs in or out, so mods see the actor (and you) online the whole time; the server sees the actor do
 * whatever you do, with the actor's own permissions. Your own player is taken out of the world (still in the
 * player list, so it is still online) behind the actor's discard connection, frozen where it stood, and goes
 * back in, exactly as it was, on {@code /actor back}. Two things the client keeps from its login: its own name and
 * skin (you are the actor to the server and to everyone else), and its profile id, so this sends it the actor's
 * game mode under that id, since that's where a client reads its own game mode.
 *
 * <p>If you disconnect while controlling, the actor leaves with your connection (saved where you left it) and is
 * spawned again a tick later; your own player leaves too, saved where you parked it. If your parked player is
 * disconnected (a kick), you are disconnected with it. A server stop hands everything back first.
 *
 * <p>The puppet guard holds: only rostered actors can be viewed or controlled, a parked body is not an actor
 * ({@link Names.Swaps}), and an actor being controlled can't be driven by {@code /actor} or {@code player.act}.
 */
public final class ActorControl implements Names.Swaps {

    private static final Logger LOGGER = LogUtils.getLogger();

    private enum Mode { VIEW, CONTROL }

    /** Who is away from their own player, and how to put them back. Keyed by their own UUID. */
    private static final class Ticket {
        final UUID owner;
        final String ownerName;
        final String actor;
        final Mode mode;
        // VIEW: where they were.
        ResourceKey<Level> dimension;
        double x;
        double y;
        double z;
        float yRot;
        float xRot;
        GameType gameMode;
        // CONTROL: the human's connection (now the actor's) and the actor's (now holding the human's body).
        ServerGamePacketListenerImpl real;
        ServerGamePacketListenerImpl parked;
        GameType shownGameMode;
        /** Set when one side left; cleaned up on the next tick, outside the disconnect. */
        boolean broken;

        Ticket(ServerPlayer owner, String actor, Mode mode) {
            this.owner = owner.getUUID();
            this.ownerName = owner.getGameProfile().getName();
            this.actor = actor;
            this.mode = mode;
        }
    }

    private static Method unsetRemoved;

    private final FakePlayerManager actors;
    private final Names names;
    private final Map<UUID, Ticket> tickets = new LinkedHashMap<>();
    private MinecraftServer server;

    private ActorControl(FakePlayerManager actors, Names names) {
        this.actors = actors;
        this.names = names;
    }

    /** Wires the control state into the facade and the game; call once at mod init. */
    public static ActorControl install(FakePlayerManager actors) {
        ActorControl control = new ActorControl(actors, actors.names());
        actors.names().setSwaps(control);
        NeoForge.EVENT_BUS.addListener((ServerTickEvent.Post e) -> control.tick(e.getServer()));
        NeoForge.EVENT_BUS.addListener((PlayerEvent.PlayerLoggedOutEvent e) -> {
            if (e.getEntity() instanceof ServerPlayer player) {
                control.left(player);
            }
        });
        NeoForge.EVENT_BUS.addListener((ServerStoppingEvent e) -> control.stopping());
        return control;
    }

    // --- what the facade and the commands ask ---

    @Override
    public boolean isParked(ServerPlayer player) {
        for (Ticket t : tickets.values()) {
            if (t.mode == Mode.CONTROL && t.parked == player.connection) {
                return true;
            }
        }
        return false;
    }

    @Override
    public String controllerOf(String name) {
        for (Ticket t : tickets.values()) {
            if (t.mode == Mode.CONTROL && t.actor.equalsIgnoreCase(name)) {
                return t.ownerName;
            }
        }
        return null;
    }

    /**
     * Whether {@code source} is someone playing as an actor. They keep {@code /actor} (to go back) even when the
     * actor isn't an operator: the human at the keyboard is the operator who started it.
     */
    public boolean isControlling(CommandSourceStack source) {
        return source.getEntity() instanceof ServerPlayer player && byRealConnection(player.connection) != null;
    }

    // --- the commands ---

    /**
     * {@code /actor <name> view}. These three tell the right player themselves: after a swap the command's own
     * source is the body behind the other connection.
     */
    public void view(CommandSourceStack source, String name) throws McTestException {
        ServerPlayer me = returnFirst(source);
        ServerPlayer actor = requireFreeActor(name);
        Ticket t = new Ticket(me, actor.getGameProfile().getName(), Mode.VIEW);
        t.dimension = me.level().dimension();
        t.x = me.getX();
        t.y = me.getY();
        t.z = me.getZ();
        t.yRot = me.getYRot();
        t.xRot = me.getXRot();
        t.gameMode = me.gameMode.getGameModeForPlayer();
        tickets.put(t.owner, t);
        me.setGameMode(GameType.SPECTATOR);
        me.setCamera(actor);
        me.sendSystemMessage(banner("Watching " + t.actor + ". ", "Sneak to look around freely."));
    }

    /** {@code /actor <name> control}. */
    public void control(CommandSourceStack source, String name) throws McTestException {
        ServerPlayer me = returnFirst(source);
        ServerPlayer actor = requireFreeActor(name);
        if (me.isDeadOrDying() || actor.isDeadOrDying()) {
            throw McTestException.invalidParams("can't take over while " + (me.isDeadOrDying() ? "you are" : name
                    + " is") + " dead");
        }
        if (me.isPassenger() || me.isVehicle() || actor.isPassenger() || actor.isVehicle()) {
            throw McTestException.invalidParams("get off (and get everything off) first: riding doesn't carry over");
        }
        me.closeContainer();
        actor.closeContainer();
        Ticket t = new Ticket(me, actor.getGameProfile().getName(), Mode.CONTROL);
        t.real = me.connection;
        t.parked = actor.connection;
        // Before the swap, so the command tree sent to the client as the actor keeps /actor (isControlling).
        tickets.put(t.owner, t);
        try {
            swap(me, actor);
        } catch (RuntimeException e) {
            tickets.remove(t.owner);
            LOGGER.error("[mc-test] Taking over {} failed", name, e);
            throw McTestException.internal("taking over " + name + " failed: " + e);
        }
        ServerPlayer now = t.real.player;
        t.shownGameMode = now.gameMode.getGameModeForPlayer();
        showOwnGameMode(t);
        now.sendSystemMessage(banner("You are " + t.actor + ". ", "Everything you do now, " + t.actor
                + " does. Your own player is parked where you left it."));
        LOGGER.info("[mc-test] {} is controlling actor {}", t.ownerName, t.actor);
    }

    /** {@code /actor back}. */
    public void back(CommandSourceStack source) throws McTestException {
        Ticket t = ticketOf(source);
        if (t == null) {
            throw McTestException.invalidParams("you aren't viewing or controlling an actor");
        }
        release(t);
        ServerPlayer me = server().getPlayerList().getPlayer(t.owner);
        if (me != null) {
            me.sendSystemMessage(Component.literal("[actor] Back as " + t.ownerName + " (from " + t.actor + ")")
                    .withStyle(ChatFormatting.GOLD));
        }
    }

    // --- the swap ---

    /**
     * Puts {@code human}'s client in {@code actor}'s body and parks {@code human} behind {@code actor}'s discard
     * connection, out of the world. The client keeps its entity id: the actor takes it, as a respawned player
     * takes the dead one's.
     */
    private void swap(ServerPlayer human, ServerPlayer actor) {
        ServerLevel actorLevel = actor.serverLevel();
        human.serverLevel().removePlayerImmediately(human, Entity.RemovalReason.CHANGED_DIMENSION);
        actorLevel.removePlayerImmediately(actor, Entity.RemovalReason.CHANGED_DIMENSION);
        ServerGamePacketListenerImpl real = human.connection;
        ServerGamePacketListenerImpl fake = actor.connection;
        int clientId = human.getId();
        human.setId(actor.getId());
        actor.setId(clientId);
        actor.connection = real;
        real.player = actor;
        human.connection = fake;
        fake.player = human;
        // The human stays removed (out of the world, still in the player list) until it goes back.
        unsetRemoved(actor);
        enterAsClient(actor, actorLevel);
    }

    /** Undoes {@link #swap}: the actor goes back behind its own connection, the human back into the world. */
    private void unswap(Ticket t) {
        ServerPlayer actor = t.real.player; // may be a respawned copy, if the actor died while controlled
        ServerPlayer human = t.parked.player;
        actor.closeContainer();
        actor.stopRiding();
        ServerLevel actorLevel = actor.serverLevel();
        actorLevel.removePlayerImmediately(actor, Entity.RemovalReason.CHANGED_DIMENSION);
        if (!human.isRemoved()) {
            // Something put the parked body back in a world (a cross-dimension teleport); take it out again.
            human.serverLevel().removePlayerImmediately(human, Entity.RemovalReason.CHANGED_DIMENSION);
        }
        int clientId = actor.getId();
        actor.setId(human.getId());
        human.setId(clientId);
        human.connection = t.real;
        t.real.player = human;
        actor.connection = t.parked;
        t.parked.player = actor;
        unsetRemoved(actor);
        actorLevel.addRespawnedPlayer(actor);
        actor.connection.resetPosition();
        unsetRemoved(human);
        enterAsClient(human, human.serverLevel());
        t.shownGameMode = human.gameMode.getGameModeForPlayer();
        showOwnGameMode(t);
    }

    /** What {@code PlayerList.respawn} sends a client for its new player, then puts the player in the world. */
    private void enterAsClient(ServerPlayer p, ServerLevel level) {
        PlayerList list = server().getPlayerList();
        LevelData data = level.getLevelData();
        p.connection.send(new ClientboundRespawnPacket(p.createCommonSpawnInfo(level), (byte) 0));
        p.connection.teleport(p.getX(), p.getY(), p.getZ(), p.getYRot(), p.getXRot());
        p.connection.send(new ClientboundSetDefaultSpawnPositionPacket(level.getSharedSpawnPos(),
                level.getSharedSpawnAngle()));
        p.connection.send(new ClientboundChangeDifficultyPacket(data.getDifficulty(), data.isDifficultyLocked()));
        p.connection.send(new ClientboundSetExperiencePacket(p.experienceProgress, p.totalExperience,
                p.experienceLevel));
        list.sendActivePlayerEffects(p);
        list.sendLevelInfo(p, level);
        list.sendPlayerPermissionLevel(p);
        level.addRespawnedPlayer(p);
        p.initInventoryMenu();
        p.setHealth(p.getHealth());
        list.sendAllPlayerInfo(p);
        p.onUpdateAbilities();
    }

    /**
     * Tells the client the game mode of the player it now drives, under its own profile id: a client reads its own
     * game mode (spectator no-clip, creative checks) from its own tab-list entry, which is still the human's.
     */
    private void showOwnGameMode(Ticket t) {
        RegistryFriendlyByteBuf buf = new RegistryFriendlyByteBuf(Unpooled.buffer(), server().registryAccess());
        try {
            buf.writeEnumSet(EnumSet.of(ClientboundPlayerInfoUpdatePacket.Action.UPDATE_GAME_MODE),
                    ClientboundPlayerInfoUpdatePacket.Action.class);
            buf.writeVarInt(1);
            buf.writeUUID(t.owner);
            buf.writeVarInt(t.shownGameMode.getId());
            t.real.send(ClientboundPlayerInfoUpdatePacket.STREAM_CODEC.decode(buf));
        } finally {
            buf.release();
        }
    }

    private static void unsetRemoved(Entity entity) {
        // Protected in Entity; ServerPlayer.changeDimension calls it for the same reason (Mojmap at runtime).
        try {
            if (unsetRemoved == null) {
                Method m = Entity.class.getDeclaredMethod("unsetRemoved");
                m.setAccessible(true);
                unsetRemoved = m;
            }
            unsetRemoved.invoke(entity);
        } catch (ReflectiveOperationException e) {
            throw new IllegalStateException("Entity.unsetRemoved is not reachable", e);
        }
    }

    // --- going back ---

    private void release(Ticket t) {
        tickets.remove(t.owner);
        if (t.mode == Mode.VIEW) {
            ServerPlayer me = server().getPlayerList().getPlayer(t.owner);
            if (me != null) {
                me.setCamera(me);
                ServerLevel level = server().getLevel(t.dimension);
                me.teleportTo(level != null ? level : me.serverLevel(), t.x, t.y, t.z, t.yRot, t.xRot);
                me.setGameMode(t.gameMode);
            }
            return;
        }
        unswap(t);
        ServerPlayer actor = t.parked.player;
        if (!actors.isActor(t.actor)) {
            // Removed from the roster while controlled (/actor remove): finish the removal now.
            names.despawnFakePlayer(t.actor);
        }
        LOGGER.info("[mc-test] {} is back from actor {} ({})", t.ownerName, t.actor, actor.position());
    }

    /** The caller's own player, back from any actor they're viewing or controlling. */
    private ServerPlayer returnFirst(CommandSourceStack source) throws McTestException {
        Ticket t = ticketOf(source);
        if (t != null) {
            release(t);
            return server().getPlayerList().getPlayer(t.owner);
        }
        if (!(source.getEntity() instanceof ServerPlayer me)) {
            throw McTestException.invalidParams("only a player can do that");
        }
        if (Names.isDiscarding(me)) {
            throw McTestException.invalidParams("an actor can't take over another actor");
        }
        return me;
    }

    private ServerPlayer requireFreeActor(String name) throws McTestException {
        if (!actors.isActor(name)) {
            throw McTestException.invalidParams("no actor named '" + name + "' — real players can't be taken over");
        }
        String controller = controllerOf(name);
        if (controller != null) {
            throw McTestException.invalidParams(name + " is already being controlled by " + controller);
        }
        ServerPlayer actor = server().getPlayerList().getPlayerByName(name);
        if (actor == null || !Names.isDiscarding(actor) || isParked(actor)) {
            throw McTestException.invalidParams(name + " isn't online");
        }
        return actor;
    }

    private Ticket ticketOf(CommandSourceStack source) {
        if (!(source.getEntity() instanceof ServerPlayer player)) {
            return null;
        }
        Ticket t = byRealConnection(player.connection);
        return t != null ? t : tickets.get(player.getUUID());
    }

    private Ticket byRealConnection(ServerGamePacketListenerImpl connection) {
        for (Ticket t : tickets.values()) {
            if (t.mode == Mode.CONTROL && t.real == connection) {
                return t;
            }
        }
        return null;
    }

    // --- the game around it ---

    private void tick(MinecraftServer s) {
        server = s;
        for (Ticket t : new ArrayList<>(tickets.values())) {
            if (t.mode != Mode.CONTROL) {
                continue;
            }
            if (t.broken) {
                cleanUp(t);
                continue;
            }
            GameType mode = t.real.player.gameMode.getGameModeForPlayer();
            if (mode != t.shownGameMode) {
                t.shownGameMode = mode;
                showOwnGameMode(t);
            }
        }
    }

    /** Someone left the game: undo whatever they were part of. Runs inside the disconnect, before the save. */
    private void left(ServerPlayer player) {
        for (Ticket t : new ArrayList<>(tickets.values())) {
            if (t.mode == Mode.VIEW && t.owner.equals(player.getUUID())) {
                tickets.remove(t.owner);
                player.setCamera(player);
                player.setGameMode(t.gameMode);
                if (player.level().dimension() == t.dimension) {
                    player.moveTo(t.x, t.y, t.z, t.yRot, t.xRot); // saved there, a moment from now
                } else {
                    LOGGER.warn("[mc-test] {} left while watching {} in another world; they'll log in there, "
                            + "as {}", t.ownerName, t.actor, t.gameMode.getName());
                }
            } else if (t.mode == Mode.CONTROL && (t.real == player.connection || t.parked == player.connection)) {
                t.broken = true;
            }
        }
    }

    /**
     * After a disconnect broke a control: the human's client went (taking the actor with it), or their parked
     * player did (taking the client with it, below). Both end the same way: the human's player leaves, saved where
     * it was parked, and the actor is spawned again from where it was left.
     */
    private void cleanUp(Ticket t) {
        if (!t.real.isAcceptingMessages()) {
            tickets.remove(t.owner);
            ServerPlayer body = t.parked.player;
            if (server().getPlayerList().getPlayer(body.getUUID()) == body) {
                t.parked.onDisconnect(new DisconnectionDetails(Component.literal("mc-test: controller left")));
            }
            if (actors.isActor(t.actor) && server().getPlayerList().getPlayerByName(t.actor) == null) {
                try {
                    names.spawnFakePlayer(t.actor, null, null, null, null);
                } catch (McTestException e) {
                    LOGGER.warn("[mc-test] Couldn't bring actor {} back: {}", t.actor, e.getMessage());
                }
            }
            LOGGER.info("[mc-test] {} left while controlling {}; both saved where they were", t.ownerName, t.actor);
        } else {
            // The parked player was disconnected: there's nothing to go back to, so the client goes too.
            t.real.disconnect(Component.literal("Your own player (" + t.ownerName + ") was disconnected while you "
                    + "were controlling " + t.actor));
        }
    }

    /** Hands everyone back before the server saves and disconnects them. */
    private void stopping() {
        for (Ticket t : new ArrayList<>(tickets.values())) {
            try {
                if (t.broken) {
                    tickets.remove(t.owner);
                } else {
                    release(t);
                }
            } catch (RuntimeException e) {
                LOGGER.warn("[mc-test] Couldn't hand {} back from {} at shutdown", t.ownerName, t.actor, e);
            }
        }
    }

    private MinecraftServer server() {
        MinecraftServer s = server;
        if (s == null) {
            s = net.neoforged.neoforge.server.ServerLifecycleHooks.getCurrentServer();
            server = s;
        }
        return s;
    }

    private static Component banner(String headline, String detail) {
        MutableComponent back = Component.literal("[back]").withStyle(style -> style.withColor(ChatFormatting.AQUA)
                .withClickEvent(new ClickEvent(ClickEvent.Action.RUN_COMMAND, "/actor back"))
                .withHoverEvent(new HoverEvent(HoverEvent.Action.SHOW_TEXT,
                        Component.literal("Back to your own player (/actor back)"))));
        return Component.literal("[actor] " + headline).withStyle(ChatFormatting.GOLD)
                .append(Component.literal(detail + " ").withStyle(ChatFormatting.GRAY))
                .append(back);
    }

    /** For {@code /actor list}: who is away in which actor. */
    public List<String> describe() {
        List<String> out = new ArrayList<>();
        for (Ticket t : tickets.values()) {
            out.add(t.ownerName + (t.mode == Mode.VIEW ? " is watching " : " is controlling ") + t.actor);
        }
        return out;
    }
}
