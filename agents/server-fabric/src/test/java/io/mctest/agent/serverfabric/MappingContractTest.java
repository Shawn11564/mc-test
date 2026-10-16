package io.mctest.agent.serverfabric;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Arrays;
import org.junit.jupiter.api.Test;

/**
 * Mapping-contract test for the Fabric (Yarn-mapped) server {@code mappings/Names.java}, run against
 * the REAL remapped Minecraft on the test classpath (Loom provides it) — the same per-version drift
 * guard {@code client-fabric} carries. It reflectively asserts the Yarn symbols the shim depends on
 * resolve with the expected shape for THIS (loader × MC version); when a version bump renames one,
 * this test names the break before a real server boot does.
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
        Class<?> world = load("net.minecraft.server.world.ServerWorld");
        assertTrue(hasMethod(world, "getBlockState"));
        assertTrue(hasMethod(world, "getEntity"));
        assertDoesNotThrow(() -> load("net.minecraft.block.BlockState"));
    }

    @Test
    void nativeFakePlayerJoinPathResolves() throws Exception {
        // spawnFakePlayer(): a real ServerPlayerEntity joined via PlayerManager.onPlayerConnect
        // behind a discard ClientConnection activated through an EmbeddedChannel.
        Class<?> connection = load("net.minecraft.network.ClientConnection");
        assertTrue(hasMethod(connection, "send"));
        Class<?> playerManager = load("net.minecraft.server.PlayerManager");
        assertTrue(hasMethod(playerManager, "onPlayerConnect"));
        Class<?> clientData = load("net.minecraft.server.network.ConnectedClientData");
        assertTrue(hasMethod(clientData, "createDefault"));
        Class<?> options = load("net.minecraft.network.packet.c2s.common.SyncedClientOptions");
        assertTrue(hasMethod(options, "createDefault"));
        assertDoesNotThrow(() -> load("net.minecraft.network.DisconnectionInfo"));
    }

    @Test
    void actorVerbSurfaceResolves() throws Exception {
        // player.act verbs: the tick-driven avatar and the per-verb primitives.
        Class<?> player = load("net.minecraft.server.network.ServerPlayerEntity");
        assertTrue(hasMethod(player, "playerTick"));
        assertTrue(hasMethod(player, "changeGameMode"));
        assertTrue(hasMethod(player, "teleport"));
        assertTrue(hasMethod(player, "attack"));
        assertTrue(hasMethod(player, "interact"));
        Class<?> networkHandler = load("net.minecraft.server.network.ServerPlayNetworkHandler");
        assertTrue(hasMethod(networkHandler, "onDisconnected"));
        assertTrue(hasMethod(networkHandler, "syncWithPlayerPosition"));
        Class<?> screenHandler = load("net.minecraft.screen.ScreenHandler");
        assertTrue(hasMethod(screenHandler, "onSlotClick"));
        Class<?> signedMessage = load("net.minecraft.network.message.SignedMessage");
        assertTrue(hasMethod(signedMessage, "ofUnsigned"));
        Class<?> gameMode = load("net.minecraft.world.GameMode");
        assertTrue(hasMethod(gameMode, "byName"));
    }

    @Test
    void menuReadSurfaceResolves() throws Exception {
        // spec/42 click-text: player.menu walks the open handler's slots and flattens their stacks'
        // names + LORE component to text, then clickMenuText clicks the slot it matched.
        Class<?> screenHandler = load("net.minecraft.screen.ScreenHandler");
        assertDoesNotThrow(() -> screenHandler.getField("slots"));
        assertTrue(hasMethod(screenHandler, "getType"));
        Class<?> slot = load("net.minecraft.screen.slot.Slot");
        assertTrue(hasMethod(slot, "getStack"));
        assertDoesNotThrow(() -> slot.getField("inventory"));
        Class<?> stack = load("net.minecraft.item.ItemStack");
        assertTrue(hasMethod(stack, "getName"));
        Class<?> lore = load("net.minecraft.component.type.LoreComponent");
        assertTrue(hasMethod(lore, "lines"));
        assertDoesNotThrow(() -> load("net.minecraft.component.DataComponentTypes"));
        // Every click mode clickMenuText can be asked for must exist as a constant.
        Class<?> action = load("net.minecraft.screen.slot.SlotActionType");
        for (String mode : new String[] {"PICKUP", "QUICK_MOVE", "SWAP", "CLONE", "THROW", "PICKUP_ALL"}) {
            assertTrue(Arrays.stream(action.getEnumConstants())
                    .anyMatch(c -> ((Enum<?>) c).name().equals(mode)), mode);
        }
    }

    @Test
    void benchActorSurfaceResolves() throws Exception {
        // spec/42: player.list live state (fakePlayerState) + /actor useblock (raycast) + the
        // Brigadier command surface ActorCommands registers.
        Class<?> player = load("net.minecraft.server.network.ServerPlayerEntity");
        assertTrue(hasMethod(player, "getHealth"));
        assertTrue(hasMethod(player, "raycast"));
        assertTrue(hasMethod(player, "getEyePos"));
        Class<?> interactionManager = load("net.minecraft.server.network.ServerPlayerInteractionManager");
        assertTrue(hasMethod(interactionManager, "getGameMode"));
        assertTrue(hasMethod(interactionManager, "interactBlock"));
        Class<?> gameMode = load("net.minecraft.world.GameMode");
        assertTrue(hasMethod(gameMode, "getName"));
        Class<?> commandManager = load("net.minecraft.server.command.CommandManager");
        assertTrue(hasMethod(commandManager, "literal"));
        assertTrue(hasMethod(commandManager, "argument"));
        Class<?> source = load("net.minecraft.server.command.ServerCommandSource");
        assertTrue(hasMethod(source, "hasPermissionLevel"));
        assertTrue(hasMethod(source, "getPosition"));
        assertTrue(hasMethod(source, "getWorld"));
        assertTrue(hasMethod(source, "sendFeedback"));
        assertTrue(hasMethod(source, "sendError"));
        assertDoesNotThrow(() -> load("net.minecraft.util.hit.HitResult"));
    }
}
