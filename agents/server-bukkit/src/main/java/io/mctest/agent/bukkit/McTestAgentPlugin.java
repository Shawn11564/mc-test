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
        // Port: config.yml wins (the runner provisions it there); else the same MCTEST_AGENT_PORT
        // env the modded agents read (spec/42 — how CC's servers module wires a sidecar without
        // touching plugin files); else the default.
        int port = getConfig().contains("port")
                ? getConfig().getInt("port", DEFAULT_PORT)
                : envPort();
        String host = getConfig().getString("host", DEFAULT_HOST);
        // Handshake token (spec/42, PROTOCOL.md §4.2): config.yml `token:` wins, else the same
        // MCTEST_AGENT_TOKEN env the modded agents read. Unset = open (throwaway test instances).
        String token = getConfig().getString("token", null);
        if (token == null || token.isEmpty()) {
            token = System.getenv("MCTEST_AGENT_TOKEN");
        }

        LogSink logSink = (level, message) -> getLogger().log(toLevel(level), message);

        // Fake-player backends (spec/42 Plan C). NATIVE first: a probe-gated reflective port of the
        // real-player-behind-a-discard-connection pattern against Paper's Mojang-mapped runtime
        // (1.20.5+) — one unresolved symbol and the probe logs it and yields null, so Spigot and
        // pre-1.20.5 Paper keep their honest skip. CARPET second (opt-in via `fakePlayers: true` in
        // config.yml): dispatches Carpet's /player command, spawn/despawn only. Neither present →
        // the capability is not advertised and those steps honestly SKIP (prime directive: honest
        // skips beat false greens).
        io.mctest.agent.bukkit.players.NativeFakePlayers nativeBackend =
                io.mctest.agent.bukkit.players.NativeFakePlayers.probe(getLogger());
        boolean carpetEnabled = getConfig().getBoolean("fakePlayers", false);
        boolean fakePlayersEnabled = nativeBackend != null || carpetEnabled;

        // Advertise the serverPlugin capability bundle (PROTOCOL.md §6.1–§6.2) — fakePlayers only
        // when a backend is present; the detail names which one, and the spec/42 persist/list
        // extensions ride on the agent-global roster (backend-neutral).
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
            fakePlayersDetail.addProperty("backend", nativeBackend != null ? "native" : "carpet");
            fakePlayersDetail.addProperty("persist", true);
            fakePlayersDetail.addProperty("list", true);
            fakePlayersDetail.addProperty("menu", true);
            if (nativeBackend != null) {
                com.google.gson.JsonArray actVerbs = new com.google.gson.JsonArray();
                for (String verb : io.mctest.agent.bukkit.players.FakePlayerManager.ACT_VERBS) {
                    actVerbs.add(verb);
                }
                fakePlayersDetail.add("verbs", actVerbs);
            }
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
                .setAuthToken(token)
                .register("truth.getWorldBlock", "worldTruth", worldTruth::getWorldBlock)
                .register("truth.getEntities", "worldTruth", worldTruth::getEntities)
                .register("truth.getContainer", "worldTruth", worldTruth::getContainer)
                .register("truth.getItem", "worldTruth", worldTruth::getItem)
                .register("truth.assertPluginState", "pluginState", stateProbe::assertPluginState)
                .register("fixture.set", "fixtures", fixtures::set)
                .register("fixture.reset", "fixtures", fixtures::reset);
        if (fakePlayersEnabled) {
            FakePlayerManager fakePlayers = new FakePlayerManager(this, nativeBackend, carpetEnabled);
            dispatch.register("player.spawnFake", "fakePlayers", fakePlayers::spawnFake)
                    .register("player.despawnFake", "fakePlayers", fakePlayers::despawnFake)
                    .register("player.list", "fakePlayers", fakePlayers::list)
                    .register("player.menu", "fakePlayers", fakePlayers::menu);
            if (nativeBackend != null) {
                dispatch.register("player.act", "fakePlayers", fakePlayers::act);
                // The per-tick pump: doTick + keep-alive cadence + outbound drain for native fakes.
                Bukkit.getScheduler().runTaskTimer(this, nativeBackend::tick, 1L, 1L);
            }
            // The in-game /actor front door (spec/42 §4; native only — its executor says so honestly).
            org.bukkit.command.PluginCommand actorCommand = getCommand("actor");
            if (actorCommand != null) {
                actorCommand.setExecutor(
                        new io.mctest.agent.bukkit.players.ActorCommand(fakePlayers));
            }
            getLogger().info("fakePlayers backend: " + (nativeBackend != null ? "native" : "carpet"));
        } else {
            getLogger().info("fakePlayers capability disabled (native probe failed — needs Paper "
                    + "1.20.5+ with the Mojang-mapped runtime — and no Carpet /player backend); "
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

    /** Reads {@code MCTEST_AGENT_PORT}, falling back to {@link #DEFAULT_PORT} (mirrors the modded agents). */
    private static int envPort() {
        String raw = System.getenv("MCTEST_AGENT_PORT");
        if (raw != null) {
            try {
                return Integer.parseInt(raw.trim());
            } catch (NumberFormatException ignored) {
                // A bad env value must not crash the server.
            }
        }
        return DEFAULT_PORT;
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
