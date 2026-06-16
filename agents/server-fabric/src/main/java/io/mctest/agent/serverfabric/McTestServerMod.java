package io.mctest.agent.serverfabric;

import com.google.gson.JsonObject;
import io.mctest.agent.core.Capabilities;
import io.mctest.agent.core.Dispatch;
import io.mctest.agent.core.LogSink;
import io.mctest.agent.core.MctpServer;
import io.mctest.agent.serverfabric.fixtures.FixtureManager;
import io.mctest.agent.serverfabric.mappings.Names;
import io.mctest.agent.serverfabric.players.FakePlayerManager;
import io.mctest.agent.serverfabric.truth.PluginStateProbe;
import io.mctest.agent.serverfabric.truth.WorldTruth;
import net.fabricmc.api.DedicatedServerModInitializer;

/**
 * The mc-test server-side agent for Fabric/NeoForge dedicated servers: a thin
 * {@link DedicatedServerModInitializer} that hosts an MCTP WebSocket server and answers the
 * server-truth / fixtures / fake-player half of the protocol (PROTOCOL.md §7.3–§7.5). It mirrors the
 * <b>wiring</b> of {@code /agents/server-bukkit}'s {@code McTestAgentPlugin} (the same six advertised
 * capabilities and the same seven handler registrations), but binds Fabric server primitives instead
 * of the Bukkit API. {@code agent.kind = serverMod}.
 *
 * <p>All wire logic, negotiation, and error mapping live in the shared {@code io.mctest.agent.core}
 * ({@code MctpServer} + {@code Dispatch}); this class only assembles them around a loader-specific
 * {@link Names} facade. Per Prime Directive 2, M5 fan-out (NeoForge server / other MC versions)
 * re-implements only {@code mappings/Names.java} — the core and these handlers are unchanged.
 *
 * <p><b>Mappings quarantine.</b> This entrypoint imports ONLY the shared core, the serverfabric handler
 * classes (pure Java over the {@link Names} façade), and the Fabric loader entrypoint API
 * ({@code net.fabricmc.api.DedicatedServerModInitializer}). Every Yarn-mapped Minecraft symbol — the
 * {@code MinecraftServer}, server-thread executor, {@code ServerWorld}, {@code BlockState}, game rules,
 * the command dispatch for Carpet fake players, and the {@code ServerLifecycleEvents} that capture the
 * server — is confined to {@link Names} (the CI import-scan enforces it).
 */
public final class McTestServerMod implements DedicatedServerModInitializer {

    /** Default MCTP port if {@code MCTEST_AGENT_PORT} is unset (matches server-bukkit's config.yml). */
    static final int DEFAULT_PORT = 25575;
    /** Loopback bind only (CI default; agents bind loopback per PROTOCOL.md §2.1). */
    static final String DEFAULT_HOST = "127.0.0.1";
    /** Granted {@code worldTruth.radiusLimit} (PROTOCOL.md §6.3). */
    static final int RADIUS_LIMIT = 64;

    private MctpServer server;

    @Override
    public void onInitializeServer() {
        int port = resolvePort();
        LogSink logSink = (level, message) -> System.out.println("[mc-test-server-fabric] " + message);

        // The loader-specific facade — the ONLY object that touches Yarn-mapped server internals. Kept
        // as the concrete type so we can read the version strings it derives from the runtime (those
        // getters are loader-specific) and install the server-lifecycle hooks that capture the server.
        Names names = new Names();

        // Advertise exactly the serverMod capability bundle (PROTOCOL.md §6.1–§6.2; mirrors server-bukkit).
        JsonObject worldTruthDetail = new JsonObject();
        worldTruthDetail.addProperty("version", 1);
        worldTruthDetail.addProperty("radiusLimit", RADIUS_LIMIT);
        JsonObject fakePlayersDetail = new JsonObject();
        fakePlayersDetail.addProperty("backend", "carpet");
        Capabilities capabilities = new Capabilities()
                .advertise("worldTruth", worldTruthDetail)
                .advertise("pluginState")
                .advertise("fixtures")
                .advertise("fakePlayers", fakePlayersDetail)
                .advertise("chat")
                .advertise("testIdTags");

        // Primitive handlers — each gated by its capability key (PROTOCOL.md §6.1). All game access
        // routes through the Names facade on the server thread.
        WorldTruth worldTruth = new WorldTruth(names, RADIUS_LIMIT);
        PluginStateProbe stateProbe = new PluginStateProbe(names);
        FixtureManager fixtures = new FixtureManager(names);
        FakePlayerManager fakePlayers = new FakePlayerManager(names);

        Dispatch dispatch = new Dispatch()
                .setAgentInfo("mc-test-server-fabric", "0.1.0", "serverMod", "java")
                .setCapabilities(capabilities)
                .setTargetInfo(names.mcVersion(), "fabric", names.loaderVersion())
                .setLogSink(logSink)
                .register("truth.getWorldBlock", "worldTruth", worldTruth::getWorldBlock)
                .register("truth.getEntities", "worldTruth", worldTruth::getEntities)
                .register("truth.assertPluginState", "pluginState", stateProbe::assertPluginState)
                .register("fixture.set", "fixtures", fixtures::set)
                .register("fixture.reset", "fixtures", fixtures::reset)
                .register("player.spawnFake", "fakePlayers", fakePlayers::spawnFake)
                .register("player.despawnFake", "fakePlayers", fakePlayers::despawnFake);

        // Defer MctpServer start until the dedicated server is up (so the server-thread bounce has a
        // thread to submit to), and stop it at shutdown. Names owns the mapped ServerLifecycleEvents and
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
