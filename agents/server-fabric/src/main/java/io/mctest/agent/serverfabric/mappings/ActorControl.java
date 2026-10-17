package io.mctest.agent.serverfabric.mappings;

import com.mojang.logging.LogUtils;
import io.mctest.agent.core.McTestException;
import io.mctest.agent.serverfabric.players.FakePlayerManager;
import io.netty.buffer.Unpooled;
import java.util.ArrayList;
import java.util.EnumSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.fabricmc.fabric.api.networking.v1.ServerPlayConnectionEvents;
import net.minecraft.entity.Entity;
import net.minecraft.network.DisconnectionInfo;
import net.minecraft.network.RegistryByteBuf;
import net.minecraft.network.packet.s2c.play.DifficultyS2CPacket;
import net.minecraft.network.packet.s2c.play.ExperienceBarUpdateS2CPacket;
import net.minecraft.network.packet.s2c.play.PlayerListS2CPacket;
import net.minecraft.network.packet.s2c.play.PlayerRespawnS2CPacket;
import net.minecraft.network.packet.s2c.play.PlayerSpawnPositionS2CPacket;
import net.minecraft.registry.RegistryKey;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.PlayerManager;
import net.minecraft.server.command.ServerCommandSource;
import net.minecraft.server.network.ServerPlayNetworkHandler;
import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.server.world.ServerWorld;
import net.minecraft.text.ClickEvent;
import net.minecraft.text.HoverEvent;
import net.minecraft.text.MutableText;
import net.minecraft.text.Text;
import net.minecraft.util.Formatting;
import net.minecraft.world.GameMode;
import net.minecraft.world.World;
import net.minecraft.world.WorldProperties;
import org.slf4j.Logger;

/**
 * Seeing as an actor, and playing as one, then going back to your own player: {@code /actor <name> view},
 * {@code /actor <name> control}, {@code /actor back}. The Yarn twin of server-neoforge's {@code ActorControl},
 * which explains the mechanism: view is vanilla spectating; control hands your connection (and your client's
 * entity id) to the actor's player the way vanilla's respawn hands a connection to a new player, and parks your
 * own player out of the world behind the actor's discard connection until you go back.
 *
 * <p>Fabric differences: {@code Entity.unsetRemoved} is opened by the mod's access widener, and the disconnect
 * signal is {@code ServerPlayConnectionEvents.DISCONNECT}, which fires before the player is saved.
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
        RegistryKey<World> dimension;
        double x;
        double y;
        double z;
        float yaw;
        float pitch;
        GameMode gameMode;
        // CONTROL: the human's handler (now the actor's) and the actor's (now holding the human's body).
        ServerPlayNetworkHandler real;
        ServerPlayNetworkHandler parked;
        GameMode shownGameMode;
        /** Set when one side left; cleaned up on the next tick, outside the disconnect. */
        boolean broken;

        Ticket(ServerPlayerEntity owner, String actor, Mode mode) {
            this.owner = owner.getUuid();
            this.ownerName = owner.getGameProfile().getName();
            this.actor = actor;
            this.mode = mode;
        }
    }

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
        ServerTickEvents.END_SERVER_TICK.register(control::tick);
        ServerPlayConnectionEvents.DISCONNECT.register((handler, s) -> control.left(handler.player));
        ServerLifecycleEvents.SERVER_STOPPING.register(s -> control.stopping());
        ServerLifecycleEvents.SERVER_STARTED.register(s -> control.server = s);
        return control;
    }

    // --- what the facade and the commands ask ---

    @Override
    public boolean isParked(ServerPlayerEntity player) {
        for (Ticket t : tickets.values()) {
            if (t.mode == Mode.CONTROL && t.parked == player.networkHandler) {
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

    /** Whether {@code source} is someone playing as an actor (they keep {@code /actor}, to go back). */
    public boolean isControlling(ServerCommandSource source) {
        return source.getEntity() instanceof ServerPlayerEntity player && byRealHandler(player.networkHandler) != null;
    }

    // --- the commands (they message the right player themselves: after a swap the source is the other body) ---

    /** {@code /actor <name> view}. */
    public void view(ServerCommandSource source, String name) throws McTestException {
        ServerPlayerEntity me = returnFirst(source);
        ServerPlayerEntity actor = requireFreeActor(name);
        Ticket t = new Ticket(me, actor.getGameProfile().getName(), Mode.VIEW);
        t.dimension = me.getWorld().getRegistryKey();
        t.x = me.getX();
        t.y = me.getY();
        t.z = me.getZ();
        t.yaw = me.getYaw();
        t.pitch = me.getPitch();
        t.gameMode = me.interactionManager.getGameMode();
        tickets.put(t.owner, t);
        me.changeGameMode(GameMode.SPECTATOR);
        me.setCameraEntity(actor);
        me.sendMessage(banner("Watching " + t.actor + ". ", "Sneak to look around freely."));
    }

    /** {@code /actor <name> control}. */
    public void control(ServerCommandSource source, String name) throws McTestException {
        ServerPlayerEntity me = returnFirst(source);
        ServerPlayerEntity actor = requireFreeActor(name);
        if (me.isDead() || actor.isDead()) {
            throw McTestException.invalidParams("can't take over while " + (me.isDead() ? "you are" : name + " is")
                    + " dead");
        }
        if (me.hasVehicle() || me.hasPassengers() || actor.hasVehicle() || actor.hasPassengers()) {
            throw McTestException.invalidParams("get off (and get everything off) first: riding doesn't carry over");
        }
        me.closeHandledScreen();
        actor.closeHandledScreen();
        Ticket t = new Ticket(me, actor.getGameProfile().getName(), Mode.CONTROL);
        t.real = me.networkHandler;
        t.parked = actor.networkHandler;
        // Before the swap, so the command tree sent to the client as the actor keeps /actor (isControlling).
        tickets.put(t.owner, t);
        try {
            swap(me, actor);
        } catch (RuntimeException e) {
            tickets.remove(t.owner);
            LOGGER.error("[mc-test] Taking over {} failed", name, e);
            throw McTestException.internal("taking over " + name + " failed: " + e);
        }
        ServerPlayerEntity now = t.real.player;
        t.shownGameMode = now.interactionManager.getGameMode();
        showOwnGameMode(t);
        now.sendMessage(banner("You are " + t.actor + ". ", "Everything you do now, " + t.actor
                + " does. Your own player is parked where you left it."));
        LOGGER.info("[mc-test] {} is controlling actor {}", t.ownerName, t.actor);
    }

    /** {@code /actor back}. */
    public void back(ServerCommandSource source) throws McTestException {
        Ticket t = ticketOf(source);
        if (t == null) {
            throw McTestException.invalidParams("you aren't viewing or controlling an actor");
        }
        release(t);
        ServerPlayerEntity me = server().getPlayerManager().getPlayer(t.owner);
        if (me != null) {
            me.sendMessage(Text.literal("[actor] Back as " + t.ownerName + " (from " + t.actor + ")")
                    .formatted(Formatting.GOLD));
        }
    }

    // --- the swap ---

    /** Puts {@code human}'s client in {@code actor}'s body and parks {@code human} out of the world. */
    private void swap(ServerPlayerEntity human, ServerPlayerEntity actor) {
        ServerWorld actorWorld = actor.getServerWorld();
        human.getServerWorld().removePlayer(human, Entity.RemovalReason.CHANGED_DIMENSION);
        actorWorld.removePlayer(actor, Entity.RemovalReason.CHANGED_DIMENSION);
        ServerPlayNetworkHandler real = human.networkHandler;
        ServerPlayNetworkHandler fake = actor.networkHandler;
        int clientId = human.getId();
        human.setId(actor.getId());
        actor.setId(clientId);
        actor.networkHandler = real;
        real.player = actor;
        human.networkHandler = fake;
        fake.player = human;
        // The human stays removed (out of the world, still in the player list) until it goes back.
        actor.unsetRemoved();
        enterAsClient(actor, actorWorld);
    }

    /** Undoes {@link #swap}: the actor goes back behind its own connection, the human back into the world. */
    private void unswap(Ticket t) {
        ServerPlayerEntity actor = t.real.player; // may be a respawned copy, if the actor died while controlled
        ServerPlayerEntity human = t.parked.player;
        actor.closeHandledScreen();
        actor.stopRiding();
        ServerWorld actorWorld = actor.getServerWorld();
        actorWorld.removePlayer(actor, Entity.RemovalReason.CHANGED_DIMENSION);
        if (!human.isRemoved()) {
            // Something put the parked body back in a world (a cross-dimension teleport); take it out again.
            human.getServerWorld().removePlayer(human, Entity.RemovalReason.CHANGED_DIMENSION);
        }
        int clientId = actor.getId();
        actor.setId(human.getId());
        human.setId(clientId);
        human.networkHandler = t.real;
        t.real.player = human;
        actor.networkHandler = t.parked;
        t.parked.player = actor;
        actor.unsetRemoved();
        actorWorld.onPlayerRespawned(actor);
        actor.networkHandler.syncWithPlayerPosition();
        human.unsetRemoved();
        enterAsClient(human, human.getServerWorld());
        t.shownGameMode = human.interactionManager.getGameMode();
        showOwnGameMode(t);
    }

    /** What {@code PlayerManager.respawnPlayer} sends a client for its new player, then puts it in the world. */
    private void enterAsClient(ServerPlayerEntity p, ServerWorld world) {
        PlayerManager list = server().getPlayerManager();
        WorldProperties props = world.getLevelProperties();
        p.networkHandler.sendPacket(new PlayerRespawnS2CPacket(p.createCommonPlayerSpawnInfo(world), (byte) 0));
        p.networkHandler.requestTeleport(p.getX(), p.getY(), p.getZ(), p.getYaw(), p.getPitch());
        p.networkHandler.sendPacket(new PlayerSpawnPositionS2CPacket(world.getSpawnPos(), world.getSpawnAngle()));
        p.networkHandler.sendPacket(new DifficultyS2CPacket(props.getDifficulty(), props.isDifficultyLocked()));
        p.networkHandler.sendPacket(new ExperienceBarUpdateS2CPacket(p.experienceProgress, p.totalExperience,
                p.experienceLevel));
        list.sendStatusEffects(p);
        list.sendWorldInfo(p, world);
        list.sendCommandTree(p);
        world.onPlayerRespawned(p);
        p.onSpawn();
        p.setHealth(p.getHealth());
        list.sendPlayerStatus(p);
        p.sendAbilitiesUpdate();
    }

    /**
     * Tells the client the game mode of the player it now drives, under its own profile id: a client reads its own
     * game mode (spectator no-clip, creative checks) from its own tab-list entry, which is still the human's.
     */
    private void showOwnGameMode(Ticket t) {
        RegistryByteBuf buf = new RegistryByteBuf(Unpooled.buffer(), server().getRegistryManager());
        try {
            buf.writeEnumSet(EnumSet.of(PlayerListS2CPacket.Action.UPDATE_GAME_MODE), PlayerListS2CPacket.Action.class);
            buf.writeVarInt(1);
            buf.writeUuid(t.owner);
            buf.writeVarInt(t.shownGameMode.getId());
            t.real.sendPacket(PlayerListS2CPacket.CODEC.decode(buf));
        } finally {
            buf.release();
        }
    }

    // --- going back ---

    private void release(Ticket t) {
        tickets.remove(t.owner);
        if (t.mode == Mode.VIEW) {
            ServerPlayerEntity me = server().getPlayerManager().getPlayer(t.owner);
            if (me != null) {
                me.setCameraEntity(me);
                ServerWorld world = server().getWorld(t.dimension);
                me.teleport(world != null ? world : me.getServerWorld(), t.x, t.y, t.z, t.yaw, t.pitch);
                me.changeGameMode(t.gameMode);
            }
            return;
        }
        unswap(t);
        if (!actors.isActor(t.actor)) {
            // Removed from the roster while controlled (/actor remove): finish the removal now.
            names.despawnFakePlayer(t.actor);
        }
        LOGGER.info("[mc-test] {} is back from actor {}", t.ownerName, t.actor);
    }

    /** The caller's own player, back from any actor they're viewing or controlling. */
    private ServerPlayerEntity returnFirst(ServerCommandSource source) throws McTestException {
        Ticket t = ticketOf(source);
        if (t != null) {
            release(t);
            return server().getPlayerManager().getPlayer(t.owner);
        }
        if (!(source.getEntity() instanceof ServerPlayerEntity me)) {
            throw McTestException.invalidParams("only a player can do that");
        }
        if (names.isDiscarding(me)) {
            throw McTestException.invalidParams("an actor can't take over another actor");
        }
        return me;
    }

    private ServerPlayerEntity requireFreeActor(String name) throws McTestException {
        if (!actors.isActor(name)) {
            throw McTestException.invalidParams("no actor named '" + name + "' — real players can't be taken over");
        }
        String controller = controllerOf(name);
        if (controller != null) {
            throw McTestException.invalidParams(name + " is already being controlled by " + controller);
        }
        ServerPlayerEntity actor = server().getPlayerManager().getPlayer(name);
        if (actor == null || !names.isDiscarding(actor) || isParked(actor)) {
            throw McTestException.invalidParams(name + " isn't online");
        }
        return actor;
    }

    private Ticket ticketOf(ServerCommandSource source) {
        if (!(source.getEntity() instanceof ServerPlayerEntity player)) {
            return null;
        }
        Ticket t = byRealHandler(player.networkHandler);
        return t != null ? t : tickets.get(player.getUuid());
    }

    private Ticket byRealHandler(ServerPlayNetworkHandler handler) {
        for (Ticket t : tickets.values()) {
            if (t.mode == Mode.CONTROL && t.real == handler) {
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
            GameMode mode = t.real.player.interactionManager.getGameMode();
            if (mode != t.shownGameMode) {
                t.shownGameMode = mode;
                showOwnGameMode(t);
            }
        }
    }

    /** Someone is leaving: undo whatever they were part of. Runs before the player is saved. */
    private void left(ServerPlayerEntity player) {
        for (Ticket t : new ArrayList<>(tickets.values())) {
            if (t.mode == Mode.VIEW && t.owner.equals(player.getUuid())) {
                tickets.remove(t.owner);
                player.setCameraEntity(player);
                player.changeGameMode(t.gameMode);
                if (player.getWorld().getRegistryKey() == t.dimension) {
                    player.refreshPositionAndAngles(t.x, t.y, t.z, t.yaw, t.pitch); // saved there, a moment from now
                } else {
                    LOGGER.warn("[mc-test] {} left while watching {} in another world; they'll log in there, as {}",
                            t.ownerName, t.actor, t.gameMode.getName());
                }
            } else if (t.mode == Mode.CONTROL && (t.real == player.networkHandler || t.parked == player.networkHandler)) {
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
        if (!t.real.isConnectionOpen()) {
            tickets.remove(t.owner);
            ServerPlayerEntity body = t.parked.player;
            if (server().getPlayerManager().getPlayer(body.getUuid()) == body) {
                t.parked.onDisconnected(new DisconnectionInfo(Text.literal("mc-test: controller left")));
            }
            if (actors.isActor(t.actor) && server().getPlayerManager().getPlayer(t.actor) == null) {
                try {
                    names.spawnFakePlayer(t.actor, null, null, null, null);
                } catch (McTestException e) {
                    LOGGER.warn("[mc-test] Couldn't bring actor {} back: {}", t.actor, e.getMessage());
                }
            }
            LOGGER.info("[mc-test] {} left while controlling {}; both saved where they were", t.ownerName, t.actor);
        } else {
            // The parked player was disconnected: there's nothing to go back to, so the client goes too.
            t.real.disconnect(Text.literal("Your own player (" + t.ownerName + ") was disconnected while you "
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
        return server;
    }

    private static Text banner(String headline, String detail) {
        MutableText back = Text.literal("[back]").styled(style -> style.withColor(Formatting.AQUA)
                .withClickEvent(new ClickEvent(ClickEvent.Action.RUN_COMMAND, "/actor back"))
                .withHoverEvent(new HoverEvent(HoverEvent.Action.SHOW_TEXT,
                        Text.literal("Back to your own player (/actor back)"))));
        return Text.literal("[actor] " + headline).formatted(Formatting.GOLD)
                .append(Text.literal(detail + " ").formatted(Formatting.GRAY))
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
