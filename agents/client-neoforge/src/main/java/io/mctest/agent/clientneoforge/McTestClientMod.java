package io.mctest.agent.clientneoforge;

import io.mctest.agent.clientneoforge.mappings.Names;
import io.mctest.agent.core.Dispatch;
import io.mctest.agent.core.EventBus;
import io.mctest.agent.core.LogSink;
import io.mctest.agent.core.MctpServer;
import io.mctest.agent.core.client.ClientAgent;
import io.mctest.agent.core.client.ClientBridge;
import net.neoforged.api.distmarker.Dist;
import net.neoforged.bus.api.IEventBus;
import net.neoforged.fml.common.Mod;
import net.neoforged.fml.event.lifecycle.FMLClientSetupEvent;

/**
 * The mc-test client-side agent entrypoint (NeoForge). A thin {@link Mod} whose CLIENT-side setup
 * ({@link FMLClientSetupEvent} on the mod event bus, {@code dist = CLIENT}) hosts an MCTP WebSocket
 * server and exposes the real client's Screen/widget tree, keyboard, and framebuffer to the runner's
 * in-process driver (DRIVERS.md §2). It is a thin shim — all wire logic, negotiation, selector
 * resolution and error mapping live in the shared {@code io.mctest.agent.core} ({@code MctpServer} +
 * {@code Dispatch} + {@code ScreenHandlers}); this class only assembles them around a loader-specific
 * {@link ClientBridge}. It performs the SAME 8-step wiring as the Fabric shim
 * ({@code /agents/client-fabric}); only the loader entrypoint (NeoForge {@code @Mod} + EventBus seam)
 * differs.
 *
 * <p><b>Mappings quarantine.</b> This entrypoint imports ONLY the shared core and the NeoForge loader
 * entrypoint/event API ({@code net.neoforged.fml.* / net.neoforged.bus.* / net.neoforged.api.distmarker.*}).
 * Every Mojmap (official Mojang) Minecraft symbol is confined to {@link Names} (the {@link ClientBridge}
 * impl) — the per-version tax (Prime Directive 2; the CI import-scan enforces it).
 *
 * <p>Advertises {@code agent.kind = clientMod} with the client capability bundle (DRIVERS.md §2.1):
 * {@code chat, command, containerGui, clientScreens, typeText, pressKey, testIdTags} plus
 * {@code screenshot, rendering} when a framebuffer is present.
 */
@Mod(value = McTestClientMod.MOD_ID, dist = Dist.CLIENT)
public final class McTestClientMod {

    /** The NeoForge modId; mirrors {@code neoforge.mods.toml} and the {@code @Mod} annotation. */
    static final String MOD_ID = "mctestclientneoforge";

    /** MCTP port read from {@code MCTEST_AGENT_PORT}; the runner's driver-inprocess scrapes the log line. */
    static final int DEFAULT_PORT = 25599;
    /** Loopback bind only (CI default; agents bind loopback per PROTOCOL.md §2.1). */
    static final String DEFAULT_HOST = "127.0.0.1";

    private MctpServer server;

    /**
     * NeoForge constructs the mod with the mod-specific event bus. We subscribe the client-setup
     * listener on it (the EventBus seam that replaces Fabric's {@code onInitializeClient}). The
     * annotation already restricts this whole mod to {@code Dist.CLIENT}, so the listener runs only on a
     * real client.
     */
    public McTestClientMod(IEventBus modEventBus) {
        modEventBus.addListener(this::onClientSetup);
    }

    /** Runs the SAME 8-step wiring as the Fabric shim, on the client during {@link FMLClientSetupEvent}. */
    private void onClientSetup(FMLClientSetupEvent event) {
        int port = resolvePort();
        LogSink logSink = (level, message) -> System.out.println("[mc-test-client-neoforge] " + message);

        // The loader-specific bridge — the ONLY object that touches Mojmap client internals. Kept as the
        // concrete type so we can read the version strings it derives from the client runtime (those
        // getters are loader-specific, NOT part of the loader-neutral ClientBridge interface).
        Names bridge = new Names();

        // EventBus wiring (see the wiring note in README §"EventBus wiring"): the loader-neutral
        // ScreenHandlers (registered by ClientAgent.buildDispatch below) emit event.screenChanged /
        // event.chat through THIS bus. MctpServer owns its own internal EventBus wired to its
        // broadcast(), but ScreenHandlers hold the bus we pass into buildDispatch — so we must point
        // that same bus at the server's transport once the server exists. MctpServer.broadcast(String)
        // (inherited from the Java-WebSocket server) fans a notification frame to every open
        // connection, which is exactly EventBus.Broadcaster's contract.
        EventBus events = new EventBus();

        Dispatch dispatch = ClientAgent.buildDispatch(
                bridge, events,
                "mc-test-client-neoforge",
                "clientMod",
                bridge.mcVersion(),
                "neoforge",
                bridge.loaderVersion());

        try {
            server = new MctpServer(DEFAULT_HOST, port, dispatch, logSink);
            // Route the handlers' EventBus emits to the server's connection broadcast (same transport
            // the server's internal bus uses).
            events.setBroadcaster(server::broadcast);
            // Non-blocking; logs "MCTP listening on :<port>" from onStart() once bound — the line the
            // runner's driver-inprocess scrapes to learn the agent's port.
            server.startMctp();
            logSink.log("INFO", "mc-test client agent starting MCTP server on "
                    + DEFAULT_HOST + ":" + port);
        } catch (RuntimeException e) {
            logSink.log("ERROR", "Failed to start MCTP server on "
                    + DEFAULT_HOST + ":" + port + ": " + e);
        }
    }

    /** @return the running MCTP server, or {@code null} before init / after a failed bind (diagnostics). */
    MctpServer server() {
        return server;
    }

    /** Reads {@code MCTEST_AGENT_PORT}, falling back to {@link #DEFAULT_PORT} when unset/unparseable. */
    private static int resolvePort() {
        String raw = System.getenv("MCTEST_AGENT_PORT");
        if (raw != null) {
            try {
                return Integer.parseInt(raw.trim());
            } catch (NumberFormatException ignored) {
                // Fall through to the default — a bad env value must not crash the client.
            }
        }
        return DEFAULT_PORT;
    }
}
