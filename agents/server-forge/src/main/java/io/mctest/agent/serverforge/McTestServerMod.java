package io.mctest.agent.serverforge;

import com.google.gson.JsonObject;
import io.mctest.agent.core.Capabilities;
import io.mctest.agent.core.Dispatch;
import io.mctest.agent.core.LogSink;
import io.mctest.agent.core.MctpServer;
import io.mctest.agent.serverforge.fixtures.FixtureManager;
import io.mctest.agent.serverforge.mappings.Names;
import io.mctest.agent.serverforge.truth.PluginStateProbe;
import io.mctest.agent.serverforge.truth.WorldTruth;
import net.minecraftforge.fml.common.Mod;

/**
 * The mc-test server-side agent for a Forge dedicated server: a thin {@link Mod} (constructor-based, the
 * modern Forge style) that hosts an MCTP WebSocket server and answers the server-truth / fixtures /
 * plugin-state half of the protocol (PROTOCOL.md §7.3–§7.5). It mirrors the <b>wiring</b> of
 * {@code /agents/server-fabric}'s {@code McTestServerMod}, but binds Mojmap-mapped Forge server
 * primitives instead of Yarn-mapped Fabric ones, and <b>drops {@code fakePlayers}</b> (Forge has no
 * Carpet fake-player backend). {@code agent.kind = serverMod}.
 *
 * <p>All wire logic, negotiation, and error mapping live in the shared {@code io.mctest.agent.core}
 * ({@code MctpServer} + {@code Dispatch}); this class only assembles them around a loader-specific
 * {@link Names} facade. Per Prime Directive 2, fan-out (other MC versions) re-implements only
 * {@code mappings/Names.java} — the core and these handlers are unchanged.
 *
 * <p><b>Mappings quarantine.</b> This entrypoint imports ONLY the shared core, the serverforge handler
 * classes (pure Java over the {@link Names} façade), and the Forge {@code @Mod} annotation. Every
 * Mojmap-mapped Minecraft symbol — the {@code MinecraftServer}, server-thread executor,
 * {@code ServerLevel}, {@code BlockState}, game rules, and the {@code ServerStarted/StoppingEvent}s that
 * capture the server — is confined to {@link Names} (the CI import-scan enforces it).
 *
 * <p>Differences from the fabric twin: (1) the {@code fakePlayers} capability and the
 * {@code player.spawnFake}/{@code player.despawnFake} handlers are NOT advertised/registered; (2) the
 * server lifecycle is captured via Forge's game event bus (owned inside {@link Names}) rather than
 * Fabric's {@code ServerLifecycleEvents}.
 */
@Mod("mctestserverforge")
public final class McTestServerMod {

    /** Default MCTP port if {@code MCTEST_AGENT_PORT} is unset (matches the server-fabric default). */
    static final int DEFAULT_PORT = 25575;
    /** Loopback bind only (CI default; agents bind loopback per PROTOCOL.md §2.1). */
    static final String DEFAULT_HOST = "127.0.0.1";
    /** Granted {@code worldTruth.radiusLimit} (PROTOCOL.md §6.3). */
    static final int RADIUS_LIMIT = 64;

    private MctpServer server;

    /**
     * Forge constructs the mod during loading. We assemble the dispatch here and arm the server-lifecycle
     * hooks (owned inside {@link Names}, which registers them on the Forge game event bus); the MCTP
     * server itself is started/stopped from those hooks so the server thread exists for the
     * {@link Names#call} bounce.
     */
    public McTestServerMod() {
        int port = resolvePort();
        LogSink logSink = (level, message) -> System.out.println("[mc-test-server-forge] " + message);

        // The loader-specific facade — the ONLY object that touches Mojmap server internals. Kept as the
        // concrete type so we can read the version strings it derives from the runtime (those getters are
        // loader-specific) and install the server-lifecycle hooks that capture the server.
        Names names = new Names();

        // Advertise exactly the serverMod capability bundle MINUS fakePlayers (PROTOCOL.md §6.1–§6.2;
        // mirrors SERVER_FORGE_CAPABILITIES in the runner's cli.ts). Forge has no Carpet backend, so
        // fakePlayers is intentionally dropped — a fakePlayers-requiring test honestly skips.
        JsonObject worldTruthDetail = new JsonObject();
        worldTruthDetail.addProperty("version", 1);
        worldTruthDetail.addProperty("radiusLimit", RADIUS_LIMIT);
        Capabilities capabilities = new Capabilities()
                .advertise("worldTruth", worldTruthDetail)
                .advertise("pluginState")
                .advertise("fixtures")
                .advertise("chat")
                .advertise("testIdTags");

        // Primitive handlers — each gated by its capability key (PROTOCOL.md §6.1). All game access
        // routes through the Names facade on the server thread. No FakePlayerManager (fakePlayers dropped).
        WorldTruth worldTruth = new WorldTruth(names, RADIUS_LIMIT);
        PluginStateProbe stateProbe = new PluginStateProbe(names);
        FixtureManager fixtures = new FixtureManager(names);

        Dispatch dispatch = new Dispatch()
                .setAgentInfo("mc-test-server-forge", "0.1.0", "serverMod", "java")
                .setCapabilities(capabilities)
                .setTargetInfo(names.mcVersion(), "forge", names.loaderVersion())
                .setLogSink(logSink)
                .register("truth.getWorldBlock", "worldTruth", worldTruth::getWorldBlock)
                .register("truth.getEntities", "worldTruth", worldTruth::getEntities)
                .register("truth.assertPluginState", "pluginState", stateProbe::assertPluginState)
                .register("fixture.set", "fixtures", fixtures::set)
                .register("fixture.reset", "fixtures", fixtures::reset);

        // Defer MctpServer start until the dedicated server is up (so the server-thread bounce has a
        // thread to submit to), and stop it at shutdown. Names owns the mapped server-lifecycle events and
        // captures the MinecraftServer; the entrypoint only passes plain Runnables.
        names.installServerLifecycle(
                () -> {
                    try {
                        server = new MctpServer(DEFAULT_HOST, port, dispatch, logSink);
                        // Non-blocking; MctpServer.onStart() logs "MCTP listening on :<port>" once bound.
                        server.startMctp();
                        logSink.log("INFO", "mc-test server agent starting MCTP server on "
                                + DEFAULT_HOST + ":" + port);
                    } catch (RuntimeException e) {
                        logSink.log("ERROR", "Failed to start MCTP server on "
                                + DEFAULT_HOST + ":" + port + ": " + e);
                    }
                },
                () -> {
                    if (server != null) {
                        server.stopMctp();
                        server = null;
                    }
                });
    }

    /** @return the running MCTP server, or {@code null} before start / after stop (diagnostics). */
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
                // Fall through to the default — a bad env value must not crash the server.
            }
        }
        return DEFAULT_PORT;
    }
}
