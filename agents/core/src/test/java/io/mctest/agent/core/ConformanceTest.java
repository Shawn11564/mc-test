package io.mctest.agent.core;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.IOException;
import java.net.ServerSocket;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Collections;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.java_websocket.client.WebSocketClient;
import org.java_websocket.drafts.Draft_6455;
import org.java_websocket.handshake.ServerHandshake;
import org.java_websocket.protocols.IProtocol;
import org.java_websocket.protocols.Protocol;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * The "mock runner replays fixtures" conformance path (ROADMAP §7.2). Boots a real {@link MctpServer}
 * with stub {@code truth.*}/{@code fixture.*}/{@code player.*} handlers returning the golden success
 * shapes, then drives it over a real WebSocket client and asserts the response {@code result} keys /
 * error {@code code}+{@code reason} against the fixtures under
 * {@code packages/protocol/fixtures/conformance/methods/*.json}.
 */
class ConformanceTest {

    private MctpServer server;
    private int port;
    private TestClient client;
    private final AtomicInteger ids = new AtomicInteger(1);

    @BeforeEach
    void setUp() throws Exception {
        port = freePort();

        // Server-agent capability set so the truth/fixture/player handlers are reachable.
        JsonObject worldTruthDetail = new JsonObject();
        worldTruthDetail.addProperty("radiusLimit", 64);
        JsonObject fakeDetail = new JsonObject();
        fakeDetail.addProperty("backend", "carpet");
        Capabilities caps = new Capabilities()
                .advertise("worldTruth", worldTruthDetail)
                .advertise("pluginState")
                .advertise("fixtures")
                .advertise("fakePlayers")
                .advertise("chat")
                .advertise("testIdTags");

        Dispatch dispatch = new Dispatch()
                .setAgentInfo("mc-test-server-bukkit", "0.1.0", "serverPlugin", "java")
                .setCapabilities(caps)
                .setTargetInfo("1.20.4", "paper", "1.20.4-R0.1");

        registerStubHandlers(dispatch);

        server = new MctpServer("127.0.0.1", port, dispatch, (level, message) -> {
        });
        server.start();
        // start() binds the port asynchronously; wait for onStart() before connecting so the client
        // connect doesn't race the bind (readiness probe, never a fixed sleep).
        long deadline = System.currentTimeMillis() + 5000L;
        while (!server.isStarted() && System.currentTimeMillis() < deadline) {
            Thread.sleep(10L);
        }

        client = new TestClient(URI.create("ws://127.0.0.1:" + port + MctpProtocol.PATH));
        assertTrue(client.connectBlocking(5, TimeUnit.SECONDS), "client must connect");
    }

    @AfterEach
    void tearDown() throws Exception {
        if (client != null) {
            client.closeBlocking();
        }
        if (server != null) {
            server.stop(2000);
        }
    }

    // --- Stub handlers: return the golden success shapes (and the failure variants on demand) ---

    private void registerStubHandlers(Dispatch dispatch) {
        dispatch.register("truth.getWorldBlock", "worldTruth", (session, params) -> {
            JsonObject result = new JsonObject();
            result.addProperty("ok", true);
            JsonObject block = new JsonObject();
            block.addProperty("type", "minecraft:oak_sign");
            JsonObject props = new JsonObject();
            props.addProperty("rotation", "8");
            block.add("properties", props);
            block.addProperty("biome", "minecraft:plains");
            result.add("block", block);
            return result;
        });

        dispatch.register("truth.getEntities", "worldTruth", (session, params) -> {
            JsonObject result = new JsonObject();
            result.addProperty("ok", true);
            result.addProperty("count", 1);
            JsonArray entities = new JsonArray();
            JsonObject e = new JsonObject();
            e.addProperty("id", "e_31:982");
            e.addProperty("uuid", "e9f1a0c2-0000-4000-8000-000000000031");
            e.addProperty("type", "minecraft:armor_stand");
            JsonObject pos = new JsonObject();
            pos.addProperty("x", 1.0);
            pos.addProperty("y", 64.0);
            pos.addProperty("z", 1.0);
            e.add("position", pos);
            entities.add(e);
            result.add("entities", entities);
            return result;
        });

        dispatch.register("truth.assertPluginState", "pluginState", (session, params) -> {
            String query = params.has("query") ? params.get("query").getAsString() : null;
            // Stub the canonical regions.exists → true; anything else → ASSERT_FAILED.
            if (!"regions.exists".equals(query)) {
                throw McTestException.assertFailed("Unknown state query: " + query);
            }
            boolean value = true;
            JsonObject expect = params.has("expect") && params.get("expect").isJsonObject()
                    ? params.getAsJsonObject("expect") : null;
            JsonObject result = new JsonObject();
            result.addProperty("ok", true);
            result.addProperty("query", query);
            result.addProperty("value", value);
            if (expect != null) {
                result.addProperty("matched", Predicates.evaluate(expect, value));
            } else {
                result.add("matched", com.google.gson.JsonNull.INSTANCE);
            }
            result.addProperty("valueJson", "true");
            return result;
        });

        dispatch.register("fixture.set", "fixtures", (session, params) -> {
            String fixture = params.has("fixture") ? params.get("fixture").getAsString() : null;
            if (!"regions.createRegion".equals(fixture)) {
                throw McTestException.fixtureFailed("Unknown fixture: " + fixture);
            }
            // Register a cleanup so session.close releases the applied fixture.
            session.resources.register(() -> {
            });
            JsonObject result = new JsonObject();
            result.addProperty("ok", true);
            result.addProperty("fixture", fixture);
            result.addProperty("applied", true);
            result.addProperty("handle", "fx_region_TestRegion");
            JsonObject sub = new JsonObject();
            sub.addProperty("regionId", "TestRegion");
            result.add("result", sub);
            return result;
        });

        dispatch.register("fixture.reset", "fixtures", (session, params) -> {
            JsonObject result = new JsonObject();
            result.addProperty("ok", true);
            if (params.has("snapshot")) {
                result.add("restored", params.get("snapshot"));
            }
            result.addProperty("tookMs", 0);
            return result;
        });

        dispatch.register("player.spawnFake", "fakePlayers", (session, params) -> {
            String name = params.has("name") ? params.get("name").getAsString() : "Bot";
            session.resources.register(() -> {
            });
            JsonObject result = new JsonObject();
            result.addProperty("ok", true);
            result.addProperty("name", name);
            result.addProperty("uuid", "069a79f4-44e9-4726-a5be-fca90e38bbbb");
            result.addProperty("handle", "fp_" + name);
            return result;
        });

        dispatch.register("player.despawnFake", "fakePlayers", (session, params) -> {
            String handle = params.has("handle") ? params.get("handle").getAsString() : null;
            JsonObject result = new JsonObject();
            result.addProperty("ok", true);
            result.addProperty("despawned", handle != null ? handle : "");
            return result;
        });
    }

    // --- Fixture-driven assertions ---

    @Test
    void sessionCreateGrantsAndRefuses() throws Exception {
        // Grant: ask only for what the server agent advertises.
        JsonObject grantParams = new JsonObject();
        grantParams.addProperty("protocolVersion", "1.0");
        grantParams.add("requiredCapabilities", arr("worldTruth", "pluginState", "fixtures"));
        JsonObject granted = call("session.create", grantParams).getAsJsonObject("result");
        assertTrue(granted.get("ok").getAsBoolean());
        assertNotNull(granted.get("sessionId"));
        assertEquals("1.0", granted.get("protocolVersion").getAsString());
        assertEquals("serverPlugin", granted.getAsJsonObject("agent").get("kind").getAsString());
        assertTrue(keys(granted.getAsJsonArray("grantedCapabilities")).contains("worldTruth"));

        // Refuse: ask for a UI capability the server agent does not offer (matches fixture
        // session.create "no-required-capabilities" error shape: -32002 METHOD_NOT_SUPPORTED + unmet).
        JsonObject refuseParams = new JsonObject();
        refuseParams.addProperty("protocolVersion", "1.0");
        refuseParams.add("requiredCapabilities", arr("clientScreens", "screenshot"));
        JsonObject error = call("session.create", refuseParams).getAsJsonObject("error");
        assertEquals(Errors.METHOD_NOT_SUPPORTED, error.get("code").getAsInt());
        JsonObject data = error.getAsJsonObject("data");
        assertEquals(Errors.REASON_METHOD_NOT_SUPPORTED, data.get("reason").getAsString());
        assertEquals(false, data.get("retryable").getAsBoolean());
        assertTrue(keys(data.getAsJsonArray("unmet")).containsAll(
                java.util.Arrays.asList("clientScreens", "screenshot")));
        assertTrue(data.has("offered"));
    }

    @Test
    void protocolVersionMismatchIsRefused() throws Exception {
        JsonObject params = new JsonObject();
        params.addProperty("protocolVersion", "2.0");
        params.add("requiredCapabilities", new JsonArray());
        JsonObject error = call("session.create", params).getAsJsonObject("error");
        assertEquals(Errors.PROTOCOL_VERSION_UNSUPPORTED, error.get("code").getAsInt());
        assertEquals(Errors.REASON_PROTOCOL_VERSION_UNSUPPORTED,
                error.getAsJsonObject("data").get("reason").getAsString());
    }

    @Test
    void sessionCreateRefusesUnsatisfiableConstraintWithNoSession() throws Exception {
        // Target is paper/1.20.4; a fabric loader constraint is unsatisfiable → -32002, no session,
        // data.unmet[]=[loader] + data.constraint=loader (PROTOCOL.md §5.1 step 2 / §5.3).
        JsonObject params = new JsonObject();
        params.addProperty("protocolVersion", "1.0");
        params.add("requiredCapabilities", arr("worldTruth"));
        JsonObject constraints = new JsonObject();
        constraints.addProperty("loader", "fabric");
        params.add("constraints", constraints);
        JsonObject error = call("session.create", params).getAsJsonObject("error");
        assertEquals(Errors.METHOD_NOT_SUPPORTED, error.get("code").getAsInt());
        JsonObject data = error.getAsJsonObject("data");
        assertTrue(keys(data.getAsJsonArray("unmet")).contains("loader"));
        assertEquals("loader", data.get("constraint").getAsString());

        // A version constraint outside the target range is likewise refused.
        JsonObject vparams = new JsonObject();
        vparams.addProperty("protocolVersion", "1.0");
        vparams.add("requiredCapabilities", new JsonArray());
        JsonObject vc = new JsonObject();
        vc.addProperty("mcVersionRange", ">=1.21");
        vparams.add("constraints", vc);
        JsonObject verror = call("session.create", vparams).getAsJsonObject("error");
        assertEquals(Errors.METHOD_NOT_SUPPORTED, verror.get("code").getAsInt());
        assertEquals("mcVersionRange", verror.getAsJsonObject("data").get("constraint").getAsString());
    }

    @Test
    void sessionCreateAcceptsSatisfiableConstraint() throws Exception {
        JsonObject params = new JsonObject();
        params.addProperty("protocolVersion", "1.0");
        params.add("requiredCapabilities", arr("worldTruth"));
        JsonObject constraints = new JsonObject();
        constraints.addProperty("loader", "paper");
        constraints.addProperty("mcVersionRange", "1.20.4");
        params.add("constraints", constraints);
        JsonObject result = call("session.create", params).getAsJsonObject("result");
        assertTrue(result.get("ok").getAsBoolean());
        assertNotNull(result.get("sessionId"));
    }

    @Test
    void sessionPingEchoesNonce() throws Exception {
        JsonObject params = new JsonObject();
        params.addProperty("nonce", "abc");
        JsonObject result = call("session.ping", params).getAsJsonObject("result");
        assertTrue(result.get("ok").getAsBoolean());
        assertEquals("abc", result.get("nonce").getAsString());
    }

    @Test
    void sessionDescribeListsCapabilities() throws Exception {
        JsonObject result = call("session.describe", null).getAsJsonObject("result");
        assertTrue(result.get("ok").getAsBoolean());
        assertEquals("1.0", result.get("protocolVersion").getAsString());
        assertTrue(keys(result.getAsJsonArray("capabilities")).contains("worldTruth"));
    }

    @Test
    void worldJoinIsNoOpForServerAgent() throws Exception {
        String session = createServerSession();
        JsonObject result = call("world.join", withSession(session, new JsonObject()))
                .getAsJsonObject("result");
        assertTrue(result.get("ok").getAsBoolean());
        // server no-op: playerName is null, serverBrand present.
        assertTrue(result.get("playerName").isJsonNull());
        assertTrue(result.has("serverBrand"));
    }

    @Test
    void assertPluginStateSuccessAndAssertFailed() throws Exception {
        String session = createServerSession();

        // success: regions.exists with expect equals true → matched true (fixture "success").
        JsonObject p = new JsonObject();
        p.addProperty("query", "regions.exists");
        JsonObject args = new JsonObject();
        args.addProperty("name", "TestRegion");
        p.add("args", args);
        JsonObject expect = new JsonObject();
        expect.addProperty("equals", true);
        p.add("expect", expect);
        JsonObject result = call("truth.assertPluginState", withSession(session, p))
                .getAsJsonObject("result");
        assertEquals("regions.exists", result.get("query").getAsString());
        assertTrue(result.get("value").getAsBoolean());
        assertTrue(result.get("matched").getAsBoolean());
        assertEquals("true", result.get("valueJson").getAsString());

        // assert-failed: unknown query → -32006 ASSERT_FAILED (fixture "assert-failed").
        JsonObject bad = new JsonObject();
        bad.addProperty("query", "regions.unknown");
        JsonObject error = call("truth.assertPluginState", withSession(session, bad))
                .getAsJsonObject("error");
        assertEquals(Errors.ASSERT_FAILED, error.get("code").getAsInt());
        assertEquals(Errors.REASON_ASSERT_FAILED, error.getAsJsonObject("data").get("reason").getAsString());
    }

    @Test
    void fixtureSetSuccessAndFixtureFailed() throws Exception {
        String session = createServerSession();

        JsonObject p = new JsonObject();
        p.addProperty("fixture", "regions.createRegion");
        JsonObject result = call("fixture.set", withSession(session, p)).getAsJsonObject("result");
        assertTrue(result.get("applied").getAsBoolean());
        assertEquals("fx_region_TestRegion", result.get("handle").getAsString());
        assertEquals("TestRegion", result.getAsJsonObject("result").get("regionId").getAsString());

        JsonObject bad = new JsonObject();
        bad.addProperty("fixture", "nope.unknown");
        JsonObject error = call("fixture.set", withSession(session, bad)).getAsJsonObject("error");
        assertEquals(Errors.FIXTURE_FAILED, error.get("code").getAsInt());
        assertEquals(Errors.REASON_FIXTURE_FAILED, error.getAsJsonObject("data").get("reason").getAsString());
    }

    @Test
    void playerSpawnFakeReturnsHandle() throws Exception {
        String session = createServerSession();
        JsonObject p = new JsonObject();
        p.addProperty("name", "Bot2");
        JsonObject result = call("player.spawnFake", withSession(session, p)).getAsJsonObject("result");
        assertEquals("Bot2", result.get("name").getAsString());
        assertEquals("fp_Bot2", result.get("handle").getAsString());
        assertNotNull(result.get("uuid"));
    }

    @Test
    void playerDespawnFakeReturnsDespawned() throws Exception {
        String session = createServerSession();
        JsonObject p = new JsonObject();
        p.addProperty("handle", "fp_Bot2");
        JsonObject result = call("player.despawnFake", withSession(session, p)).getAsJsonObject("result");
        assertTrue(result.get("ok").getAsBoolean());
        assertEquals("fp_Bot2", result.get("despawned").getAsString());
    }

    @Test
    void truthGetWorldBlockReturnsBlock() throws Exception {
        String session = createServerSession();
        JsonObject p = new JsonObject();
        p.addProperty("world", "world");
        p.addProperty("x", 100);
        p.addProperty("y", 64);
        p.addProperty("z", -200);
        JsonObject block = call("truth.getWorldBlock", withSession(session, p))
                .getAsJsonObject("result").getAsJsonObject("block");
        assertEquals("minecraft:oak_sign", block.get("type").getAsString());
        assertTrue(block.has("biome"));
    }

    @Test
    void truthGetEntitiesReturnsEntities() throws Exception {
        String session = createServerSession();
        JsonObject p = new JsonObject();
        JsonObject center = new JsonObject();
        center.addProperty("x", 0);
        center.addProperty("y", 64);
        center.addProperty("z", 0);
        p.add("center", center);
        p.addProperty("radius", 16);
        JsonObject result = call("truth.getEntities", withSession(session, p)).getAsJsonObject("result");
        assertEquals(1, result.get("count").getAsInt());
        assertNotNull(result.getAsJsonArray("entities").get(0).getAsJsonObject().get("id"));
    }

    @Test
    void fixtureResetSuccessRestoresSnapshotName() throws Exception {
        String session = createServerSession();
        JsonObject p = new JsonObject();
        p.addProperty("snapshot", "regions-baseline");
        JsonObject result = call("fixture.reset", withSession(session, p)).getAsJsonObject("result");
        assertTrue(result.get("ok").getAsBoolean());
        assertEquals("regions-baseline", result.get("restored").getAsString());
        assertTrue(result.has("tookMs"));
    }

    @Test
    void ungrantedMethodIsMethodNotSupported() throws Exception {
        // Create a session that does NOT grant fakePlayers, then call player.spawnFake → -32002.
        JsonObject params = new JsonObject();
        params.addProperty("protocolVersion", "1.0");
        params.add("requiredCapabilities", arr("worldTruth"));
        String session = call("session.create", params)
                .getAsJsonObject("result").get("sessionId").getAsString();

        JsonObject p = new JsonObject();
        p.addProperty("name", "Bot2");
        JsonObject error = call("player.spawnFake", withSession(session, p)).getAsJsonObject("error");
        assertEquals(Errors.METHOD_NOT_SUPPORTED, error.get("code").getAsInt());
        assertEquals(Errors.REASON_METHOD_NOT_SUPPORTED,
                error.getAsJsonObject("data").get("reason").getAsString());
    }

    @Test
    void unknownSessionIsInvalidParams() throws Exception {
        JsonObject p = new JsonObject();
        p.addProperty("sessionId", "s_does_not_exist");
        JsonObject error = call("session.close", p).getAsJsonObject("error");
        assertEquals(Errors.INVALID_PARAMS, error.get("code").getAsInt());
        assertEquals(Errors.REASON_INVALID_PARAMS,
                error.getAsJsonObject("data").get("reason").getAsString());
    }

    @Test
    void sessionCloseReleasesResources() throws Exception {
        String session = createServerSession();
        // Apply a fixture and spawn a fake → both register cleanups.
        JsonObject fx = new JsonObject();
        fx.addProperty("fixture", "regions.createRegion");
        call("fixture.set", withSession(session, fx));
        JsonObject fp = new JsonObject();
        fp.addProperty("name", "Bot2");
        call("player.spawnFake", withSession(session, fp));

        JsonObject closed = call("session.close", withSession(session, new JsonObject()))
                .getAsJsonObject("result");
        assertTrue(closed.get("ok").getAsBoolean());

        // After close the session is invalid → any stateful call fails -32602.
        JsonObject error = call("fixture.reset", withSession(session, new JsonObject()))
                .getAsJsonObject("error");
        assertEquals(Errors.INVALID_PARAMS, error.get("code").getAsInt());
    }

    @Test
    void goldenFixtureFilesAreReadableAndCovered() throws Exception {
        // Sanity: the golden fixtures this test replays exist on disk where the plan says.
        Path dir = fixturesDir();
        for (String method : new String[]{"session.create", "session.ping", "world.join",
                "truth.assertPluginState", "truth.getWorldBlock", "truth.getEntities",
                "fixture.set", "fixture.reset", "player.spawnFake", "player.despawnFake"}) {
            Path f = dir.resolve(method + ".json");
            assertTrue(Files.exists(f), "missing golden fixture: " + f);
            JsonObject fixture = JsonParser.parseString(
                    new String(Files.readAllBytes(f))).getAsJsonObject();
            assertEquals(method, fixture.get("method").getAsString());
        }
    }

    // --- Helpers ---

    private String createServerSession() throws Exception {
        JsonObject params = new JsonObject();
        params.addProperty("protocolVersion", "1.0");
        params.add("requiredCapabilities", arr("worldTruth", "pluginState", "fixtures", "fakePlayers"));
        JsonObject result = call("session.create", params).getAsJsonObject("result");
        return result.get("sessionId").getAsString();
    }

    private JsonObject withSession(String sessionId, JsonObject p) {
        p.addProperty("sessionId", sessionId);
        return p;
    }

    private JsonObject call(String method, JsonObject params) throws Exception {
        int id = ids.getAndIncrement();
        JsonObject req = new JsonObject();
        req.addProperty("jsonrpc", "2.0");
        req.addProperty("id", id);
        req.addProperty("method", method);
        if (params != null) {
            req.add("params", params);
        }
        client.send(req.toString());
        String response = client.awaitFrame(5);
        assertNotNull(response, "no response for " + method);
        JsonObject env = JsonParser.parseString(response).getAsJsonObject();
        assertEquals("2.0", env.get("jsonrpc").getAsString());
        assertEquals(id, env.get("id").getAsInt(), "id must echo");
        return env;
    }

    private static JsonArray arr(String... values) {
        JsonArray a = new JsonArray();
        for (String v : values) {
            a.add(v);
        }
        return a;
    }

    private static java.util.List<String> keys(JsonArray arr) {
        java.util.List<String> out = new java.util.ArrayList<>();
        if (arr != null) {
            for (JsonElement el : arr) {
                out.add(el.getAsString());
            }
        }
        return out;
    }

    private static Path fixturesDir() {
        // Tests run with cwd = agents/core; walk up to the repo root.
        Path base = Paths.get("").toAbsolutePath();
        for (int i = 0; i < 6 && base != null; i++) {
            Path candidate = base.resolve("packages/protocol/fixtures/conformance/methods");
            if (Files.isDirectory(candidate)) {
                return candidate;
            }
            base = base.getParent();
        }
        return Paths.get("packages/protocol/fixtures/conformance/methods");
    }

    private static int freePort() throws IOException {
        try (ServerSocket s = new ServerSocket(0)) {
            s.setReuseAddress(true);
            return s.getLocalPort();
        }
    }

    /** A minimal MCTP WebSocket client that queues received text frames for the test to await. */
    private static final class TestClient extends WebSocketClient {
        private final BlockingQueue<String> frames = new ArrayBlockingQueue<>(64);

        TestClient(URI uri) {
            super(uri, new Draft_6455(Collections.emptyList(),
                    Collections.<IProtocol>singletonList(new Protocol(MctpProtocol.SUBPROTOCOL))));
        }

        @Override
        public void onOpen(ServerHandshake handshakedata) {
        }

        @Override
        public void onMessage(String message) {
            frames.add(message);
        }

        @Override
        public void onClose(int code, String reason, boolean remote) {
        }

        @Override
        public void onError(Exception ex) {
        }

        String awaitFrame(int seconds) throws InterruptedException {
            return frames.poll(seconds, TimeUnit.SECONDS);
        }
    }
}
