package io.mctest.agent.core.client;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import io.mctest.agent.core.Capabilities;
import io.mctest.agent.core.Dispatch;
import io.mctest.agent.core.ElementModel.Element;
import io.mctest.agent.core.ElementModel.ScreenSnapshot;
import io.mctest.agent.core.Errors;
import io.mctest.agent.core.MctpProtocol;
import io.mctest.agent.core.MctpServer;
import java.io.IOException;
import java.net.ServerSocket;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.List;
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
 * The client-agent conformance path: mirrors {@link io.mctest.agent.core.ConformanceTest} (a real
 * {@link MctpServer} driven over a real WebSocket client) but registers the loader-neutral
 * {@link ScreenHandlers} against a {@link FakeClientBridge} (no Minecraft), then replays the golden
 * {@code screen.*} fixtures under {@code packages/protocol/fixtures/conformance/methods/screen.*.json}.
 * It asserts the result keys / error {@code code}+{@code reason} for every advertised client method
 * (get, listElements + selector + empty, clickElement success/ELEMENT_NOT_FOUND/AMBIGUOUS, typeText,
 * pressKey, screenshot base64, waitForScreen match/TIMEOUT, close, world.runCommand, world.waitForChat)
 * plus the {@code world.join} join-hook ({@code playerName}).
 *
 * <p>EventBus seam: handlers must emit {@code event.screenChanged} on the SERVER's {@link
 * io.mctest.agent.core.EventBus} ({@code server.events()}), which {@code MctpServer} owns. The wiring is
 * therefore: build the {@code Dispatch} (caps + hooks), construct {@code MctpServer(.., dispatch, ..)},
 * THEN {@code ScreenHandlers.register(dispatch, bridge, server.events())} — registering after
 * construction so the handlers capture the server's broadcasting bus.
 */
class ScreenConformanceTest {

    private MctpServer server;
    private int port;
    private FakeClientBridge bridge;
    private TestClient client;
    private final AtomicInteger ids = new AtomicInteger(1);

    @BeforeEach
    void setUp() throws Exception {
        port = freePort();
        bridge = new FakeClientBridge();

        // Client-agent capabilities (framebuffer present → screenshot + rendering advertised).
        Capabilities caps = ClientCapabilities.build(true);
        Dispatch dispatch = new Dispatch()
                .setAgentInfo("mc-test-client-fabric", "0.1.0", "clientMod", "java")
                .setCapabilities(caps)
                .setTargetInfo("1.21.1", "fabric", "0.16.0");

        // world.join → bridge.joinServer; world.leave → bridge.leaveServer (the client connect).
        dispatch.setJoinHook((session, params) -> {
            String host = params.has("host") ? params.get("host").getAsString() : null;
            int p = params.has("port") ? params.get("port").getAsInt() : 25565;
            String username = params.has("username") ? params.get("username").getAsString() : null;
            bridge.joinServer(host, p, username);
            JsonObject extra = new JsonObject();
            extra.addProperty("playerName", username != null ? username : "");
            return extra;
        });
        dispatch.setLeaveHook((session, params) -> {
            bridge.leaveServer();
            return new JsonObject();
        });

        server = new MctpServer("127.0.0.1", port, dispatch, (level, message) -> {
        });
        // Register the client handlers against the SERVER's EventBus so event.screenChanged broadcasts.
        ScreenHandlers.register(dispatch, bridge, server.events());
        server.start();
        // start() binds the port asynchronously; wait for onStart() before connecting (readiness probe,
        // never a fixed sleep) so the client connect doesn't race the bind.
        awaitStarted();

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

    // --- screen.* fixture-driven assertions ---

    @Test
    void screenGetReturnsSnapshot() throws Exception {
        String session = createClientSession();
        JsonObject result = call("screen.get", withSession(session, new JsonObject()))
                .getAsJsonObject("result");
        assertTrue(result.get("ok").getAsBoolean());
        JsonObject screen = result.getAsJsonObject("screen");
        assertEquals("clientScreen", screen.get("kind").getAsString());
        assertEquals("regions:root", screen.get("screenId").getAsString());
        assertTrue(screen.getAsJsonArray("elements").size() >= 1);
    }

    @Test
    void listElementsFiltersBySelectorAndAllowsEmpty() throws Exception {
        String session = createClientSession();

        // Filter by the "Regions" button testId → exactly one element.
        JsonObject p = new JsonObject();
        JsonObject selector = new JsonObject();
        selector.addProperty("testId", "regions:root:regions");
        p.add("selector", selector);
        JsonObject filtered = call("screen.listElements", withSession(session, p))
                .getAsJsonObject("result");
        assertEquals(1, filtered.get("count").getAsInt());
        assertEquals("regions:root:regions",
                filtered.getAsJsonArray("elements").get(0).getAsJsonObject().get("testId").getAsString());

        // An empty match is OK (not an error) — count 0, elements [].
        JsonObject empty = new JsonObject();
        JsonObject noMatch = new JsonObject();
        noMatch.addProperty("testId", "does:not:exist");
        empty.add("selector", noMatch);
        JsonObject emptyResult = call("screen.listElements", withSession(session, empty))
                .getAsJsonObject("result");
        assertTrue(emptyResult.get("ok").getAsBoolean());
        assertEquals(0, emptyResult.get("count").getAsInt());
        assertEquals(0, emptyResult.getAsJsonArray("elements").size());
    }

    @Test
    void clickElementSuccessAndElementNotFoundAndAmbiguous() throws Exception {
        String session = createClientSession();

        // success: click the "Regions" button by label → screenChanged true, resolved.via=label.
        JsonObject p = new JsonObject();
        JsonObject sel = new JsonObject();
        sel.addProperty("label", "Regions");
        p.add("selector", sel);
        p.addProperty("button", "left");
        p.addProperty("clickType", "single");
        JsonObject result = call("screen.clickElement", withSession(session, p))
                .getAsJsonObject("result");
        assertTrue(result.get("ok").getAsBoolean());
        assertTrue(result.get("screenChanged").getAsBoolean());
        JsonObject resolved = result.getAsJsonObject("resolved");
        assertEquals("label", resolved.get("via").getAsString());
        assertEquals("regions:root:regions", resolved.get("widgetId").getAsString());
        assertEquals("regions:root", resolved.get("screenId").getAsString());
        assertTrue(bridge.clicks.contains("regions:root:regions"), "bridge recorded the click");

        // element-not-found: a selector matching nothing → -32000 ELEMENT_NOT_FOUND.
        JsonObject miss = new JsonObject();
        JsonObject missSel = new JsonObject();
        missSel.addProperty("label", "Nope");
        miss.add("selector", missSel);
        JsonObject notFound = call("screen.clickElement", withSession(session, miss))
                .getAsJsonObject("error");
        assertEquals(Errors.ELEMENT_NOT_FOUND, notFound.get("code").getAsInt());
        assertEquals(Errors.REASON_ELEMENT_NOT_FOUND,
                notFound.getAsJsonObject("data").get("reason").getAsString());

        // ambiguous: a selector matching >1 with no nth/index → -32001 AMBIGUOUS_SELECTOR.
        JsonObject amb = new JsonObject();
        JsonObject ambSel = new JsonObject();
        ambSel.addProperty("role", "listItem");
        amb.add("selector", ambSel);
        JsonObject ambiguous = call("screen.clickElement", withSession(session, amb))
                .getAsJsonObject("error");
        assertEquals(Errors.AMBIGUOUS_SELECTOR, ambiguous.get("code").getAsInt());
        assertEquals(Errors.REASON_AMBIGUOUS_SELECTOR,
                ambiguous.getAsJsonObject("data").get("reason").getAsString());
    }

    @Test
    void typeTextSucceedsAndForwardsToBridge() throws Exception {
        String session = createClientSession();
        JsonObject p = new JsonObject();
        JsonObject sel = new JsonObject();
        sel.addProperty("role", "input");
        p.add("selector", sel);
        p.addProperty("text", "TestRegion");
        p.addProperty("clear", true);
        p.addProperty("submit", false);
        JsonObject result = call("screen.typeText", withSession(session, p)).getAsJsonObject("result");
        assertTrue(result.get("ok").getAsBoolean());
        assertFalse(result.get("screenChanged").getAsBoolean());
        assertEquals("TestRegion", bridge.lastTypedText);
    }

    @Test
    void pressKeyResolvesGlfwCode() throws Exception {
        String session = createClientSession();
        JsonObject p = new JsonObject();
        p.addProperty("key", "inventory"); // "key.inventory"-style id → "e" via the bridge? no: unknown → -1
        JsonArray mods = new JsonArray();
        mods.add("shift");
        p.add("modifiers", mods);
        JsonObject result = call("screen.pressKey", withSession(session, p)).getAsJsonObject("result");
        assertTrue(result.get("ok").getAsBoolean());
        // bridge reports screenChanged from whatever code it received; the fake flips it true for ESC.
        assertEquals(KeyNames.glfwCode("inventory"), bridge.lastKeyCode);

        // A known key resolves to a real GLFW code (escape=256).
        JsonObject esc = new JsonObject();
        esc.addProperty("key", "escape");
        JsonObject escResult = call("screen.pressKey", withSession(session, esc))
                .getAsJsonObject("result");
        assertTrue(escResult.get("ok").getAsBoolean());
        assertEquals(256, bridge.lastKeyCode);
        assertTrue(escResult.get("screenChanged").getAsBoolean());
    }

    @Test
    void screenshotReturnsBase64Png() throws Exception {
        String session = createClientSession();
        JsonObject result = call("screen.screenshot", withSession(session, new JsonObject()))
                .getAsJsonObject("result");
        assertTrue(result.get("ok").getAsBoolean());
        // Canonical NESTED shape: result.image = { format, width, height, encoding, data } — NOT a flat
        // top-level image string. This must line up with the screen.screenshot golden fixture.
        JsonObject image = result.getAsJsonObject("image");
        assertEquals("png", image.get("format").getAsString());
        assertEquals("base64", image.get("encoding").getAsString());
        byte[] decoded = Base64.getDecoder().decode(image.get("data").getAsString());
        assertEquals(FakeClientBridge.PNG.length, decoded.length);
        // Dimensions parsed from the PNG IHDR (the fake's header encodes 2x3).
        assertEquals(2, image.get("width").getAsInt());
        assertEquals(3, image.get("height").getAsInt());
        // Cross-check the golden fixture's success result: `image` is an OBJECT carrying `data`/`format`.
        JsonObject goldenImage = goldenSuccessResult("screen.screenshot", "success-inline")
                .getAsJsonObject("image");
        assertTrue(goldenImage.has("data") && goldenImage.has("format") && goldenImage.has("encoding"),
                "golden screenshot result must nest data/format/encoding under image");
    }

    @Test
    void waitForScreenMatchesAndTimesOut() throws Exception {
        String session = createClientSession();

        // match: the canned snapshot has screenId "regions:root" / kind "clientScreen", title contains
        // "Regions". Send the CANONICAL wire key `title` (what the runner emits after translating the
        // authoring `titleContains` → `title`); reading the wrong key would match ANY open screen.
        JsonObject p = new JsonObject();
        JsonObject match = new JsonObject();
        match.addProperty("title", "Regions");
        p.add("match", match);
        p.addProperty("timeoutMs", 2000);
        JsonObject result = call("screen.waitForScreen", withSession(session, p))
                .getAsJsonObject("result");
        assertTrue(result.get("ok").getAsBoolean());
        assertEquals("regions:root", result.getAsJsonObject("screen").get("screenId").getAsString());
        // A title that does NOT match must NOT spuriously succeed (proves the title filter is honored).
        JsonObject wrong = new JsonObject();
        JsonObject wrongMatch = new JsonObject();
        wrongMatch.addProperty("title", "NoSuchScreenTitle");
        wrong.add("match", wrongMatch);
        wrong.addProperty("timeoutMs", 200);
        JsonObject wrongErr = call("screen.waitForScreen", withSession(session, wrong))
                .getAsJsonObject("error");
        assertEquals(Errors.TIMEOUT, wrongErr.get("code").getAsInt());
        // Cross-check the golden fixture's success result carries a `screen` snapshot.
        assertTrue(goldenSuccessResult("screen.waitForScreen", "success").has("screen"));

        // timeout: a match that never holds → -32003 TIMEOUT.
        JsonObject t = new JsonObject();
        JsonObject neverMatch = new JsonObject();
        neverMatch.addProperty("screenId", "no:such:screen");
        t.add("match", neverMatch);
        t.addProperty("timeoutMs", 200);
        JsonObject error = call("screen.waitForScreen", withSession(session, t))
                .getAsJsonObject("error");
        assertEquals(Errors.TIMEOUT, error.get("code").getAsInt());
        assertEquals(Errors.REASON_TIMEOUT, error.getAsJsonObject("data").get("reason").getAsString());
    }

    @Test
    void closeReportsScreenWasOpen() throws Exception {
        String session = createClientSession();
        JsonObject result = call("screen.close", withSession(session, new JsonObject()))
                .getAsJsonObject("result");
        assertTrue(result.get("ok").getAsBoolean());
        assertTrue(result.get("screenChanged").getAsBoolean());
        assertTrue(bridge.closed);
    }

    @Test
    void worldRunCommandStripsLeadingSlash() throws Exception {
        String session = createClientSession();
        JsonObject p = new JsonObject();
        p.addProperty("command", "/or");
        JsonObject result = call("world.runCommand", withSession(session, p)).getAsJsonObject("result");
        assertTrue(result.get("ok").getAsBoolean());
        assertFalse(result.get("screenChanged").getAsBoolean());
        assertEquals("or", bridge.lastCommand);
    }

    @Test
    void worldWaitForChatMatchesAndTimesOut() throws Exception {
        String session = createClientSession();

        // match: the fake bridge holds "Region loaded: TestRegion".
        JsonObject p = new JsonObject();
        JsonObject filter = new JsonObject();
        filter.addProperty("contains", "Region loaded");
        p.add("filter", filter);
        p.addProperty("timeoutMs", 2000);
        JsonObject result = call("world.waitForChat", withSession(session, p)).getAsJsonObject("result");
        assertTrue(result.get("ok").getAsBoolean());
        JsonObject chat = result.getAsJsonObject("chat");
        assertTrue(chat.get("text").getAsString().contains("Region loaded"));
        assertTrue(chat.has("plain"));
        assertTrue(chat.has("raw"));

        // timeout: a filter that never matches → -32003 TIMEOUT.
        JsonObject t = new JsonObject();
        JsonObject neverFilter = new JsonObject();
        neverFilter.addProperty("contains", "nothing-like-this");
        t.add("filter", neverFilter);
        t.addProperty("timeoutMs", 200);
        JsonObject error = call("world.waitForChat", withSession(session, t)).getAsJsonObject("error");
        assertEquals(Errors.TIMEOUT, error.get("code").getAsInt());
        assertEquals(Errors.REASON_TIMEOUT, error.getAsJsonObject("data").get("reason").getAsString());
    }

    @Test
    void worldJoinHookReturnsPlayerName() throws Exception {
        String session = createClientSession();
        JsonObject p = new JsonObject();
        p.addProperty("host", "localhost");
        p.addProperty("port", 25565);
        p.addProperty("username", "Tester");
        JsonObject result = call("world.join", withSession(session, p)).getAsJsonObject("result");
        assertTrue(result.get("ok").getAsBoolean());
        // Client agent join hook fired: playerName is the username (not null like the server no-op).
        assertEquals("Tester", result.get("playerName").getAsString());
        assertEquals("localhost", bridge.joinedHost);
        assertEquals("Tester", bridge.joinedUsername);
    }

    @Test
    void clickEmitsCanonicalScreenChangedEvent() throws Exception {
        String session = createClientSession();
        JsonObject p = new JsonObject();
        JsonObject sel = new JsonObject();
        sel.addProperty("label", "Regions");
        p.add("selector", sel);

        // Send the click directly and scan frames for the event.screenChanged NOTIFICATION (no id).
        int id = ids.getAndIncrement();
        JsonObject req = new JsonObject();
        req.addProperty("jsonrpc", "2.0");
        req.addProperty("id", id);
        req.addProperty("method", "screen.clickElement");
        req.add("params", withSession(session, p));
        client.send(req.toString());

        JsonObject event = null;
        for (int i = 0; i < 16 && event == null; i++) {
            String frame = client.awaitFrame(5);
            assertNotNull(frame, "expected frames after click");
            JsonObject env = JsonParser.parseString(frame).getAsJsonObject();
            boolean isNotification = !env.has("id") || env.get("id").isJsonNull();
            String method = env.has("method") ? env.get("method").getAsString() : null;
            if (isNotification && "event.screenChanged".equals(method)) {
                event = env;
            }
        }
        assertNotNull(event, "expected an event.screenChanged notification");
        // Canonical payload (PROTOCOL.md §3.6/§7.6): params.sessionId + params.data{change,screenId,kind,title}.
        JsonObject params = event.getAsJsonObject("params");
        assertEquals(session, params.get("sessionId").getAsString());
        JsonObject data = params.getAsJsonObject("data");
        assertEquals("replaced", data.get("change").getAsString());
        assertEquals("regions:root", data.get("screenId").getAsString());
        assertEquals("clientScreen", data.get("kind").getAsString());
        assertTrue(data.has("title"));
    }

    @Test
    void goldenScreenFixtureFilesAreReadableAndCovered() throws Exception {
        Path dir = fixturesDir();
        for (String method : new String[]{"screen.get", "screen.listElements", "screen.clickElement",
                "screen.typeText", "screen.pressKey", "screen.screenshot", "screen.waitForScreen",
                "screen.close"}) {
            Path f = dir.resolve(method + ".json");
            assertTrue(Files.exists(f), "missing golden fixture: " + f);
            JsonObject fixture = JsonParser.parseString(
                    new String(Files.readAllBytes(f))).getAsJsonObject();
            assertEquals(method, fixture.get("method").getAsString());
        }
    }

    // --- Helpers ---

    private String createClientSession() throws Exception {
        JsonObject params = new JsonObject();
        params.addProperty("protocolVersion", "1.0");
        params.add("requiredCapabilities",
                arr("clientScreens", "typeText", "pressKey", "screenshot", "chat", "command"));
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
        // Skip any event.screenChanged notifications (no id) and return the matching response.
        for (int i = 0; i < 16; i++) {
            String response = client.awaitFrame(5);
            assertNotNull(response, "no response for " + method);
            JsonObject env = JsonParser.parseString(response).getAsJsonObject();
            if (!env.has("id") || env.get("id").isJsonNull()) {
                continue; // a server→client notification; not our response.
            }
            assertEquals("2.0", env.get("jsonrpc").getAsString());
            assertEquals(id, env.get("id").getAsInt(), "id must echo");
            return env;
        }
        throw new AssertionError("no id-bearing response for " + method);
    }

    private static JsonArray arr(String... values) {
        JsonArray a = new JsonArray();
        for (String v : values) {
            a.add(v);
        }
        return a;
    }

    /** The {@code result} object of a named success response in a golden {@code screen.*} fixture. */
    private static JsonObject goldenSuccessResult(String method, String responseName) throws Exception {
        Path f = fixturesDir().resolve(method + ".json");
        JsonObject fixture = JsonParser.parseString(new String(Files.readAllBytes(f))).getAsJsonObject();
        for (JsonElement r : fixture.getAsJsonArray("responses")) {
            JsonObject ro = r.getAsJsonObject();
            if (responseName.equals(ro.get("name").getAsString())) {
                return ro.getAsJsonObject("envelope").getAsJsonObject("result");
            }
        }
        throw new AssertionError("no response '" + responseName + "' in " + method + " fixture");
    }

    private static Path fixturesDir() {
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

    /** Waits (bounded) for the MctpServer to finish binding the port (onStart() sets isStarted()). */
    private void awaitStarted() throws InterruptedException {
        long deadline = System.currentTimeMillis() + 5000L;
        while (!server.isStarted() && System.currentTimeMillis() < deadline) {
            Thread.sleep(10L);
        }
        assertTrue(server.isStarted(), "server must bind");
    }

    /**
     * A no-Minecraft {@link ClientBridge} returning a canned {@link ScreenSnapshot} (a "Regions" button
     * {@code regions:root:regions}, a list, two "TestRegion"-ish listItems so {@code role=listItem} is
     * ambiguous), recording clicks/typed text/keys/commands, returning a fixed PNG, and holding a
     * "Region loaded: TestRegion" chat line for {@code world.waitForChat}.
     */
    static final class FakeClientBridge implements ClientBridge {
        // A minimal but real PNG header: 8-byte signature + IHDR(length,type,width=2,height=3) = 24 bytes,
        // so ScreenHandlers.pngDimensions reads width=2/height=3 from the IHDR.
        static final byte[] PNG = {
            (byte) 0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A, // signature
            0x00, 0x00, 0x00, 0x0D, 'I', 'H', 'D', 'R',         // IHDR length(13) + type
            0x00, 0x00, 0x00, 0x02,                             // width = 2
            0x00, 0x00, 0x00, 0x03,                             // height = 3
        };

        final List<String> clicks = new ArrayList<>();
        String lastTypedText;
        int lastKeyCode = Integer.MIN_VALUE;
        String lastCommand;
        boolean closed;
        String joinedHost;
        String joinedUsername;

        @Override
        public ScreenSnapshot snapshot() {
            ScreenSnapshot snap = new ScreenSnapshot();
            snap.screenId = "regions:root";
            snap.kind = "clientScreen";
            snap.title = "OpenRegions Regions";
            snap.titleRaw = "{\"text\":\"OpenRegions Regions\"}";

            Element button = new Element("regions:root:regions", "button", "Regions");
            button.text = "Regions";
            button.testId = "regions:root:regions";
            snap.elements.add(button);

            // An input field (role=input) for typeText resolution.
            Element input = new Element("regions:root:search", "input", "");
            snap.elements.add(input);

            // Two list entries so role=listItem matches >1 (ambiguity control).
            Element entry1 = new Element("regions:entry:TestRegion", "listItem", "TestRegion");
            entry1.testId = "regions:entry:TestRegion";
            snap.elements.add(entry1);
            Element entry2 = new Element("regions:entry:Other", "listItem", "Other");
            entry2.testId = "regions:entry:Other";
            snap.elements.add(entry2);
            return snap;
        }

        @Override
        public boolean clickElement(String elementId, String button, String clickType) {
            clicks.add(elementId);
            return true; // a click always changes the screen in this fake.
        }

        @Override
        public boolean typeText(String elementId, String text, boolean clear, boolean submit) {
            this.lastTypedText = text;
            return false;
        }

        @Override
        public boolean pressKey(String keyName, int glfwKeyCode, List<String> modifiers) {
            this.lastKeyCode = glfwKeyCode;
            return glfwKeyCode == 256; // pretend ESC closes a screen.
        }

        @Override
        public boolean closeScreen() {
            this.closed = true;
            return true;
        }

        @Override
        public byte[] screenshotPng() {
            return PNG.clone();
        }

        @Override
        public boolean hasFramebuffer() {
            return true;
        }

        @Override
        public void joinServer(String host, int port, String username) {
            this.joinedHost = host;
            this.joinedUsername = username;
        }

        @Override
        public void leaveServer() {
        }

        @Override
        public void runCommand(String command) {
            this.lastCommand = command;
        }

        @Override
        public void sendChat(String message) {
        }

        @Override
        public List<String> recentChat() {
            List<String> chat = new ArrayList<>();
            chat.add("Region loaded: TestRegion");
            return chat;
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
