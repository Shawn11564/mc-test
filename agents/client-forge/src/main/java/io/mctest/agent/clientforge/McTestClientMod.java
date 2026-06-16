package io.mctest.agent.clientforge;

import io.mctest.agent.clientforge.mappings.Names;
import io.mctest.agent.core.Dispatch;
import io.mctest.agent.core.EventBus;
import io.mctest.agent.core.LogSink;
import io.mctest.agent.core.MctpServer;
import io.mctest.agent.core.client.ClientAgent;
import io.mctest.agent.core.client.ClientBridge;
import net.minecraftforge.api.distmarker.Dist;
import net.minecraftforge.eventbus.api.IEventBus;
import net.minecraftforge.fml.DistExecutor;
import net.minecraftforge.fml.common.Mod;
import net.minecraftforge.fml.event.lifecycle.FMLClientSetupEvent;
import net.minecraftforge.fml.javafmlmod.FMLJavaModLoadingContext;

/**
 * The mc-test client-side agent entrypoint (Forge). A thin {@link Mod} that, on CLIENT-side setup
 * ({@link FMLClientSetupEvent}, {@code dist = CLIENT}), hosts an MCTP WebSocket server and exposes the
 * real client's Screen/widget tree, keyboard, and framebuffer to the runner's in-process driver
 * (DRIVERS.md §2). It is a thin shim — all wire logic, negotiation, selector resolution and error
 * mapping live in the shared {@code io.mctest.agent.core} ({@code MctpServer} + {@code Dispatch} +
 * {@code ScreenHandlers}); this class only assembles them around a loader-specific {@link ClientBridge}.
 * It runs the SAME 8-step wiring as the Fabric shim's {@code onInitializeClient}.
 *
 * <p><b>Mappings quarantine.</b> This entrypoint imports ONLY the shared core and the Forge loader
 * entrypoint/event API ({@code net.minecraftforge.fml.*}, {@code net.minecraftforge.eventbus.*},
 * {@code net.minecraftforge.api.distmarker.*}). Every MCP-SRG / official-name Minecraft symbol is
 * confined to {@link Names} (the {@link ClientBridge} impl) — the per-version tax (Prime Directive 2;
 * the CI import-scan enforces it).
 *
 * <p>Advertises {@code agent.kind = clientMod} with the client capability bundle (DRIVERS.md §2.1):
 * {@code chat, command, containerGui, clientScreens, typeText, pressKey, testIdTags} plus
 * {@code screenshot, rendering} when a framebuffer is present.
 */
@Mod("mc-test-client-forge")
public final class McTestClientMod {

    /** MCTP port read from {@code MCTEST_AGENT_PORT}; the runner's driver-inprocess scrapes the log line. */
    static final int DEFAULT_PORT = 25599;
    /** Loopback bind only (CI default; agents bind loopback per PROTOCOL.md §2.1). */
    static final String DEFAULT_HOST = "127.0.0.1";

    private MctpServer server;

    public McTestClientMod() {
        // Register the client-setup listener on the MOD event bus. The setup body runs ONLY on the
        // physical client dist (DistExecutor.safeRunWhenOn(Dist.CLIENT, ...)) so a dedicated server
        // never tries to touch a window/framebuffer.
        IEventBus modEventBus = FMLJavaModLoadingContext.get().getModEventBus();
        modEventBus.addListener(this::onClientSetup);
    }

    /** CLIENT-side setup: assemble core + bridge and host the MCTP server (Dist.CLIENT only). */
    private void onClientSetup(FMLClientSetupEvent event) {
        DistExecutor.safeRunWhenOn(Dist.CLIENT, () -> this::startAgent);
    }

    /** The SAME 8-step wiring as the Fabric shim's {@code onInitializeClient}. */
    private void startAgent() {
        int port = resolvePort();
        LogSink logSink = (level, message) -> System.out.println("[mc-test-client-forge] " + message);

        // The loader-specific bridge — the ONLY object that touches MCP-SRG / official-mapped client
        // internals. Kept as the concrete type so we can read the version strings it derives from the
        // client runtime (those getters are loader-specific, NOT part of the loader-neutral
        // ClientBridge interface).
        Names bridge = new Names();

        // EventBus wiring (mirrors the Fabric shim): the loader-neutral ScreenHandlers (registered by
        // ClientAgent.buildDispatch below) emit event.screenChanged / event.chat through THIS bus.
        // MctpServer owns its own internal EventBus wired to its broadcast(), but ScreenHandlers hold
        // the bus we pass into buildDispatch — so we must point that same bus at the server's transport
        // once the server exists. MctpServer.broadcast(String) (inherited from the Java-WebSocket
        // server) fans a notification frame to every open connection, which is exactly
        // EventBus.Broadcaster's contract.
        EventBus events = new EventBus();

        Dispatch dispatch = ClientAgent.buildDispatch(
                bridge, events,
                "mc-test-client-forge",
                "clientMod",
                bridge.mcVersion(),
                "forge",
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
