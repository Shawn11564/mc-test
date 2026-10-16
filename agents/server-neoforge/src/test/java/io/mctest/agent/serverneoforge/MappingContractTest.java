package io.mctest.agent.serverneoforge;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Arrays;
import org.junit.jupiter.api.Test;

/**
 * Mapping-contract test for the NeoForge (Mojmap) server {@code mappings/Names.java}, run against the
 * REAL Mojang-mapped Minecraft on the test classpath (NeoGradle userdev provides it) — the same
 * per-version drift guard {@code server-fabric} carries for Yarn. It reflectively asserts the Mojmap
 * symbols the shim depends on resolve with the expected shape for THIS (loader × MC version); when a
 * version bump renames one, this test names the break before a real server boot does.
 *
 * <p>Uses {@link Class#forName(String, boolean, ClassLoader)} with {@code initialize=false} (metadata
 * only — no server bootstrap). Mapped names appear only as STRINGS, outside the production
 * mappings-quarantine (the import-scan polices {@code src/main} only).
 */
class MappingContractTest {

    private Class<?> load(String name) throws ClassNotFoundException {
        return Class.forName(name, false, getClass().getClassLoader());
    }

    private static boolean hasMethod(Class<?> c, String name) {
        return Arrays.stream(c.getMethods()).anyMatch(m -> m.getName().equals(name));
    }

    @Test
    void worldAndBlockApiResolve() throws Exception {
        Class<?> level = load("net.minecraft.server.level.ServerLevel");
        assertTrue(hasMethod(level, "getBlockState"));
        assertTrue(hasMethod(level, "getEntity"));
        assertDoesNotThrow(() -> load("net.minecraft.world.level.block.state.BlockState"));
    }

    @Test
    void nativeFakePlayerJoinPathResolves() throws Exception {
        // spawnFakePlayer(): a real ServerPlayer joined via PlayerList.placeNewPlayer behind a
        // discard Connection activated through an EmbeddedChannel.
        Class<?> connection = load("net.minecraft.network.Connection");
        assertTrue(hasMethod(connection, "send"));
        Class<?> playerList = load("net.minecraft.server.players.PlayerList");
        assertTrue(hasMethod(playerList, "placeNewPlayer"));
        Class<?> cookie = load("net.minecraft.server.network.CommonListenerCookie");
        assertTrue(hasMethod(cookie, "createInitial"));
        Class<?> clientInfo = load("net.minecraft.server.level.ClientInformation");
        assertTrue(hasMethod(clientInfo, "createDefault"));
        assertDoesNotThrow(() -> load("net.minecraft.network.DisconnectionDetails"));
    }

    @Test
    void actorVerbSurfaceResolves() throws Exception {
        // player.act verbs: the tick-driven avatar and the per-verb primitives.
        Class<?> player = load("net.minecraft.server.level.ServerPlayer");
        assertTrue(hasMethod(player, "doTick"));
        assertTrue(hasMethod(player, "setGameMode"));
        assertTrue(hasMethod(player, "teleportTo"));
        assertTrue(hasMethod(player, "attack"));
        assertTrue(hasMethod(player, "interactOn"));
        assertTrue(hasMethod(player, "hasDisconnected"));
        Class<?> listener = load("net.minecraft.server.network.ServerGamePacketListenerImpl");
        assertTrue(hasMethod(listener, "onDisconnect"));
        assertTrue(hasMethod(listener, "resetPosition"));
        Class<?> menu = load("net.minecraft.world.inventory.AbstractContainerMenu");
        assertTrue(hasMethod(menu, "clicked"));
        Class<?> chatMessage = load("net.minecraft.network.chat.PlayerChatMessage");
        assertTrue(hasMethod(chatMessage, "unsigned"));
        Class<?> gameType = load("net.minecraft.world.level.GameType");
        assertTrue(hasMethod(gameType, "byName"));
    }

    @Test
    void menuReadSurfaceResolves() throws Exception {
        // spec/42 click-text: player.menu walks the open menu's slots and flattens their stacks'
        // names + LORE component to text, then clickMenuText clicks the slot it matched.
        Class<?> menu = load("net.minecraft.world.inventory.AbstractContainerMenu");
        assertDoesNotThrow(() -> menu.getField("slots"));
        assertTrue(hasMethod(menu, "getType"));
        Class<?> slot = load("net.minecraft.world.inventory.Slot");
        assertTrue(hasMethod(slot, "getItem"));
        assertDoesNotThrow(() -> slot.getField("container"));
        Class<?> stack = load("net.minecraft.world.item.ItemStack");
        assertTrue(hasMethod(stack, "getHoverName"));
        Class<?> lore = load("net.minecraft.world.item.component.ItemLore");
        assertTrue(hasMethod(lore, "lines"));
        assertDoesNotThrow(() -> load("net.minecraft.core.component.DataComponents"));
        // Every click mode clickMenuText can be asked for must exist as a constant.
        Class<?> click = load("net.minecraft.world.inventory.ClickType");
        for (String mode : new String[] {"PICKUP", "QUICK_MOVE", "SWAP", "CLONE", "THROW", "PICKUP_ALL"}) {
            assertTrue(Arrays.stream(click.getEnumConstants())
                    .anyMatch(c -> ((Enum<?>) c).name().equals(mode)), mode);
        }
    }

    @Test
    void benchActorSurfaceResolves() throws Exception {
        // spec/42: player.list live state (fakePlayerState) + /actor useblock (pick) + the
        // Brigadier command surface ActorCommands registers.
        Class<?> player = load("net.minecraft.server.level.ServerPlayer");
        assertTrue(hasMethod(player, "getHealth"));
        assertTrue(hasMethod(player, "pick"));
        assertTrue(hasMethod(player, "getEyePosition"));
        assertTrue(hasMethod(player, "serverLevel"));
        Class<?> gameMode = load("net.minecraft.server.level.ServerPlayerGameMode");
        assertTrue(hasMethod(gameMode, "getGameModeForPlayer"));
        assertTrue(hasMethod(gameMode, "useItemOn"));
        Class<?> gameType = load("net.minecraft.world.level.GameType");
        assertTrue(hasMethod(gameType, "getName"));
        Class<?> chunkCache = load("net.minecraft.server.level.ServerChunkCache");
        assertTrue(hasMethod(chunkCache, "move"));
        Class<?> commands = load("net.minecraft.commands.Commands");
        assertTrue(hasMethod(commands, "literal"));
        assertTrue(hasMethod(commands, "argument"));
        Class<?> source = load("net.minecraft.commands.CommandSourceStack");
        assertTrue(hasMethod(source, "hasPermission"));
        assertTrue(hasMethod(source, "getPosition"));
        assertTrue(hasMethod(source, "getLevel"));
        assertTrue(hasMethod(source, "sendSuccess"));
        assertTrue(hasMethod(source, "sendFailure"));
        assertTrue(hasMethod(source, "getTextName"));
        assertDoesNotThrow(() -> load("net.minecraft.world.phys.HitResult"));
    }

    @Test
    void actorUpkeepSurfaceResolves() throws Exception {
        // The actor pump (doTick, respawn through the client's respawn packet), the channel claim that lets
        // mods send actors their packets, the useitem/mine/drop/hotbar verbs, and the echo of what an actor
        // is told.
        Class<?> attributes = load("net.neoforged.neoforge.network.registration.ChannelAttributes");
        assertDoesNotThrow(() -> attributes.getField("ADHOC_CHANNELS"));
        assertDoesNotThrow(() -> load("net.neoforged.neoforge.event.tick.ServerTickEvent$Post"));
        Class<?> listener = load("net.minecraft.server.network.ServerGamePacketListenerImpl");
        assertTrue(hasMethod(listener, "handleClientCommand"));
        assertTrue(hasMethod(listener, "handleSetCarriedItem"));
        assertTrue(hasMethod(listener, "handleUseItem"));
        assertTrue(hasMethod(listener, "handlePlayerAction"));
        assertTrue(hasMethod(listener, "getConnection"));
        Class<?> drop = load("net.minecraft.network.protocol.game.ServerboundPlayerActionPacket$Action");
        for (String action : new String[] {"DROP_ITEM", "DROP_ALL_ITEMS"}) {
            assertTrue(Arrays.stream(drop.getEnumConstants())
                    .anyMatch(c -> ((Enum<?>) c).name().equals(action)), action);
        }
        assertTrue(hasMethod(load("net.minecraft.server.level.ServerPlayerGameMode"), "destroyBlock"));
        // /actor look|useblock|mine <x y z>
        Class<?> blockPos = load("net.minecraft.commands.arguments.coordinates.BlockPosArgument");
        assertTrue(hasMethod(blockPos, "blockPos"));
        assertTrue(hasMethod(blockPos, "getBlockPos"));
        assertTrue(hasMethod(blockPos, "getLoadedBlockPos"));
        Class<?> action = load("net.minecraft.network.protocol.game.ServerboundClientCommandPacket$Action");
        assertTrue(Arrays.stream(action.getEnumConstants())
                .anyMatch(c -> ((Enum<?>) c).name().equals("PERFORM_RESPAWN")));
        assertDoesNotThrow(() -> load("net.minecraft.network.protocol.game.ServerboundSetCarriedItemPacket")
                .getConstructor(int.class));
        Class<?> player = load("net.minecraft.server.level.ServerPlayer");
        assertTrue(hasMethod(player, "isDeadOrDying"));
        assertTrue(hasMethod(player, "hasPermissions"));
        assertDoesNotThrow(() -> player.getField("wonGame"));
        assertTrue(hasMethod(load("net.minecraft.network.protocol.game.ClientboundSystemChatPacket"), "overlay"));
        assertTrue(hasMethod(load("net.minecraft.network.protocol.game.ClientboundSetActionBarTextPacket"), "text"));
        assertTrue(hasMethod(load("net.minecraft.network.protocol.game.ClientboundSetTitleTextPacket"), "text"));
        assertTrue(hasMethod(load("net.minecraft.network.protocol.game.ClientboundSetSubtitleTextPacket"), "text"));
        assertTrue(hasMethod(load("net.minecraft.network.protocol.game.ClientboundBundlePacket"), "subPackets"));
        assertTrue(hasMethod(load("net.minecraft.network.PacketSendListener"), "onSuccess"));
    }
}
