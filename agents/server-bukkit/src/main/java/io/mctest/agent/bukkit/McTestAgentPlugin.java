package io.mctest.agent.bukkit;

import com.google.gson.JsonObject;
import io.mctest.agent.bukkit.fixtures.FixtureManager;
import io.mctest.agent.bukkit.gui.ServerGuiBridge;
import io.mctest.agent.bukkit.players.FakePlayerManager;
import io.mctest.agent.bukkit.truth.PluginStateProbe;
import io.mctest.agent.bukkit.truth.WorldTruth;
import io.mctest.agent.core.Capabilities;
import io.mctest.agent.core.Dispatch;
import io.mctest.agent.core.LogSink;
import io.mctest.agent.core.MctpServer;
import java.util.logging.Level;
import org.bukkit.Bukkit;
import org.bukkit.plugin.java.JavaPlugin;

/**
 * The mc-test server-side agent: a Bukkit/Paper plugin that hosts an MCTP WebSocket server and answers
 * the server-truth / fixtures / fake-player half of the protocol (PROTOCOL.md §7.3–§7.5). It is a thin
 * shim — all wire logic, negotiation, and error mapping live in the shared {@code io.mctest.agent.core}
 * ({@code MctpServer} + {@code Dispatch}); this plugin only binds Bukkit primitives behind the 7
 * advertised handlers and runs every game access on the server thread via {@link MainThread}.
 *
 * <p>Bukkit/Paper API only — no NMS / Mojang-mapped symbols — so the agent needs no per-version remap.
 * Advertises exactly {@code worldTruth, pluginState, fixtures, fakePlayers, chat, testIdTags} with
 * {@code agent.kind = serverPlugin}.
 */
public final class McTestAgentPlugin extends JavaPlugin {

    /** Default MCTP port if {@code config.yml} omits {@code port}. */
    static final int DEFAULT_PORT = 25575;
    /** Loopback bind only (CI default; agents bind loopback per PROTOCOL.md §2.1). */
    static final String DEFAULT_HOST = "127.0.0.1";
    /** Granted {@code worldTruth.radiusLimit} (PROTOCOL.md §6.3). */
    static final int RADIUS_LIMIT = 64;

    private MctpServer server;

    @Override
    public void onEnable() {
        saveDefaultConfig();
        int port = getConfig().getInt("port", DEFAULT_PORT);
        String host = getConfig().getString("host", DEFAULT_HOST);

        LogSink logSink = (level, message) -> getLogger().log(toLevel(level), message);

        // Whether to advertise fake players. The FakePlayerManager backend dispatches Carpet's
        // /player command, which does NOT exist on plain Paper — advertising a capability we cannot
        // honor would turn spawnFakePlayer steps into red failures instead of honest skips (prime
        // directive: honest skips beat false greens). Default OFF; opt in via `fakePlayers: true` in
        // config.yml only where a Carpet-style /player command is present (e.g. a Fabric+Carpet
        // server agent). When off, the runner sees no `fakePlayers` cap and honestly SKIPS those steps.
        boolean fakePlayersEnabled = getConfig().getBoolean("fakePlayers", false);

        // Advertise the serverPlugin capability bundle (PROTOCOL.md §6.1–§6.2) — fakePlayers only
        // when a backend is present.
        JsonObject worldTruthDetail = new JsonObject();
        worldTruthDetail.addProperty("version", 1);
        worldTruthDetail.addProperty("radiusLimit", RADIUS_LIMIT);
        Capabilities capabilities = new Capabilities()
                .advertise("worldTruth", worldTruthDetail)
                .advertise("pluginState")
                .advertise("fixtures")
                .advertise("chat")
                .advertise("testIdTags");
        if (fakePlayersEnabled) {
            JsonObject fakePlayersDetail = new JsonObject();
            fakePlayersDetail.addProperty("backend", "carpet");
            capabilities.advertise("fakePlayers", fakePlayersDetail);
        }

        // Primitive handlers — each gated by its capability key (PROTOCOL.md §6.1).
        WorldTruth worldTruth = new WorldTruth(this, RADIUS_LIMIT);
        PluginStateProbe stateProbe = new PluginStateProbe(this);
        FixtureManager fixtures = new FixtureManager(this);

        Dispatch dispatch = new Dispatch()
                .setAgentInfo("mc-test-agent-bukkit", getDescription().getVersion(),
                        "serverPlugin", "java")
                .setCapabilities(capabilities)
                .setTargetInfo(serverMinecraftVersion(), "paper", Bukkit.getBukkitVersion())
                .setLogSink(logSink)
                .register("truth.getWorldBlock", "worldTruth", worldTruth::getWorldBlock)
                .register("truth.getEntities", "worldTruth", worldTruth::getEntities)
                .register("truth.assertPluginState", "pluginState", stateProbe::assertPluginState)
                .register("fixture.set", "fixtures", fixtures::set)
                .register("fixture.reset", "fixtures", fixtures::reset);
        if (fakePlayersEnabled) {
            FakePlayerManager fakePlayers = new FakePlayerManager(this);
            dispatch.register("player.spawnFake", "fakePlayers", fakePlayers::spawnFake)
                    .register("player.despawnFake", "fakePlayers", fakePlayers::despawnFake);
        } else {
            getLogger().info("fakePlayers capability disabled (no Carpet /player backend on plain Paper); "
                    + "spawnFakePlayer steps will honestly skip. Set 'fakePlayers: true' in "
                    + "plugins/mc-test-agent/config.yml when a Carpet-style /player command is available.");
        }

        // Optional tiny server-GUI cross-check listener (no MCTP method of its own).
        Bukkit.getPluginManager().registerEvents(new ServerGuiBridge(), this);

        try {
            server = new MctpServer(host, port, dispatch, logSink);
            // Non-blocking; logs "MCTP listening on :<port>" from onStart() once bound.
            server.startMctp();
            getLogger().info("mc-test server agent starting MCTP server on " + host + ":" + port);
        } catch (RuntimeException e) {
            getLogger().log(Level.SEVERE, "Failed to start MCTP server on " + host + ":" + port, e);
        }
    }

    @Override
    public void onDisable() {
        if (server != null) {
            server.stopMctp();
            server = null;
        }
    }

    /** @return the running MCTP server, or {@code null} before enable / after disable (diagnostics). */
    MctpServer server() {
        return server;
    }

    /** Best-effort Minecraft version from the Bukkit version string (e.g. "1.20.4-R0.1-SNAPSHOT"). */
    private static String serverMinecraftVersion() {
        String bukkit = Bukkit.getBukkitVersion();
        if (bukkit != null) {
            int dash = bukkit.indexOf('-');
            return dash > 0 ? bukkit.substring(0, dash) : bukkit;
        }
        return null;
    }

    /** Maps the loader-neutral LogSink level string onto a {@link java.util.logging.Level}. */
    private static Level toLevel(String level) {
        if (level == null) {
            return Level.INFO;
        }
        switch (level.toUpperCase(java.util.Locale.ROOT)) {
            case "ERROR":
                return Level.SEVERE;
            case "WARN":
            case "WARNING":
                return Level.WARNING;
            case "DEBUG":
            case "TRACE":
                return Level.FINE;
            default:
                return Level.INFO;
        }
    }
}
