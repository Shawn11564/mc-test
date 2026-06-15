package io.mctest.agent.core.client;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import io.mctest.agent.core.Dispatch;
import io.mctest.agent.core.ElementModel.Element;
import io.mctest.agent.core.ElementModel.ScreenSnapshot;
import io.mctest.agent.core.EventBus;
import io.mctest.agent.core.McTestException;
import io.mctest.agent.core.McTestSession;
import io.mctest.agent.core.SelectorMatch;
import java.util.Base64;
import java.util.List;
import java.util.regex.Pattern;
import java.util.regex.PatternSyntaxException;

/**
 * Registers the loader-neutral client-side {@code screen.*} + client {@code world.*} handlers onto a
 * {@link Dispatch}, each gated by its capability key (PROTOCOL.md §7.2/§7.3). Every handler is a dumb
 * primitive: it reads a fresh {@link ScreenSnapshot} from the {@link ClientBridge}, resolves the
 * selector with the shared {@link SelectorMatch} (zero → {@code ELEMENT_NOT_FOUND}; &gt;1 without
 * {@code nth}/{@code index} → {@code AMBIGUOUS_SELECTOR}), performs exactly one observable action, and
 * returns the canonical result shape. All retries/waits/assertions live in the runner; the only bounded
 * wait here is the per-call {@code timeoutMs} poll inside {@code waitForScreen}/{@code waitForChat}.
 *
 * <p>{@code event.screenChanged} notifications are emitted on the {@link EventBus} the
 * {@link io.mctest.agent.core.MctpServer} owns; pass {@code server.events()} so the events reach
 * connected clients. {@code world.join}/{@code world.leave} are NOT here — they are {@link Dispatch}
 * built-ins routed to the bridge via the Dispatch world hook (see {@link ClientAgent}).
 */
public final class ScreenHandlers {

    private static final long DEFAULT_TIMEOUT_MS = 5000L;
    private static final long POLL_INTERVAL_MS = 100L;

    /** Selector keys probed (in order) to fill {@code resolved.via} for a click. */
    private static final String[] VIA_KEYS = {
        "label", "text", "textContains", "testId", "role", "itemType", "loreContains"
    };

    private ScreenHandlers() {
    }

    /**
     * Registers {@code screen.*} + client-side {@code world.*} handlers, gated by their capability, onto
     * {@code dispatch}. {@code events} is the {@code MctpServer}'s {@link EventBus}; handlers emit
     * {@code event.screenChanged} on {@code screen.clickElement}/{@code screen.close} when the screen
     * actually changed.
     */
    public static void register(Dispatch dispatch, ClientBridge bridge, EventBus events) {
        dispatch.register("screen.get", "clientScreens", (session, params) -> screenGet(bridge));
        dispatch.register("screen.listElements", "clientScreens",
                (session, params) -> listElements(bridge, params));
        dispatch.register("screen.clickElement", "clientScreens",
                (session, params) -> clickElement(bridge, events, session, params));
        dispatch.register("screen.typeText", "typeText",
                (session, params) -> typeText(bridge, params));
        dispatch.register("screen.pressKey", "pressKey",
                (session, params) -> pressKey(bridge, params));
        dispatch.register("screen.screenshot", "screenshot",
                (session, params) -> screenshot(bridge));
        dispatch.register("screen.waitForScreen", "clientScreens",
                (session, params) -> waitForScreen(bridge, params));
        dispatch.register("screen.close", "clientScreens",
                (session, params) -> close(bridge, events, session));

        dispatch.register("world.runCommand", "command",
                (session, params) -> runCommand(bridge, params));
        dispatch.register("world.sendChat", "chat",
                (session, params) -> sendChat(bridge, params));
        dispatch.register("world.waitForChat", "chat",
                (session, params) -> waitForChat(bridge, params));
    }

    // --- screen.* ---

    private static JsonObject screenGet(ClientBridge bridge) {
        JsonObject result = new JsonObject();
        result.addProperty("ok", true);
        result.add("screen", bridge.snapshot().toJson());
        return result;
    }

    private static JsonObject listElements(ClientBridge bridge, JsonObject params) {
        ScreenSnapshot snap = bridge.snapshot();
        List<Element> elements = snap.elements;
        JsonObject selector = optObject(params, "selector");
        if (selector != null) {
            // An empty match is OK (not an error) for listElements — the runner decides.
            elements = SelectorMatch.match(snap.elements, selector);
        }
        JsonArray arr = new JsonArray();
        for (Element e : elements) {
            arr.add(e.toJson());
        }
        JsonObject result = new JsonObject();
        result.addProperty("ok", true);
        result.addProperty("count", arr.size());
        result.add("elements", arr);
        return result;
    }

    private static JsonObject clickElement(ClientBridge bridge, EventBus events, McTestSession session,
            JsonObject params) throws McTestException {
        ScreenSnapshot snap = bridge.snapshot();
        JsonObject selector = optObject(params, "selector");
        Element el = resolveOne(snap, selector);

        String button = optString(params, "button");
        String clickType = optString(params, "clickType");
        boolean changed = bridge.clickElement(el.elementId, button, clickType);
        if (changed) {
            emitScreenChanged(bridge, events, session, "replaced");
        }

        JsonObject resolved = new JsonObject();
        resolved.addProperty("via", via(selector));
        resolved.addProperty("widgetId", el.elementId);
        if (snap.screenId != null) {
            resolved.addProperty("screenId", snap.screenId);
        }

        JsonObject result = new JsonObject();
        result.addProperty("ok", true);
        result.addProperty("screenChanged", changed);
        result.add("resolved", resolved);
        return result;
    }

    private static JsonObject typeText(ClientBridge bridge, JsonObject params) throws McTestException {
        // Optional selector → resolve to elementId; absent selector means "type into the focused field".
        String elementId = null;
        JsonObject selector = optObject(params, "selector");
        if (selector != null) {
            elementId = resolveOne(bridge.snapshot(), selector).elementId;
        }
        String text = optString(params, "text");
        boolean clear = optBoolean(params, "clear", false);
        boolean submit = optBoolean(params, "submit", false);
        bridge.typeText(elementId, text != null ? text : "", clear, submit);

        JsonObject result = new JsonObject();
        result.addProperty("ok", true);
        result.addProperty("screenChanged", false);
        return result;
    }

    private static JsonObject pressKey(ClientBridge bridge, JsonObject params) {
        String key = optString(params, "key");
        int code = KeyNames.glfwCode(key);
        java.util.List<String> mods = stringList(params, "modifiers");
        boolean changed = bridge.pressKey(key, code, mods);

        JsonObject result = new JsonObject();
        result.addProperty("ok", true);
        result.addProperty("screenChanged", changed);
        return result;
    }

    private static JsonObject screenshot(ClientBridge bridge) throws McTestException {
        byte[] png = bridge.screenshotPng();
        if (png == null) {
            throw McTestException.worldNotReady("no framebuffer");
        }
        // Canonical nested shape (PROTOCOL.md §7.4 / screen.screenshot golden fixture):
        // result.image = { format, width?, height?, encoding, data }.
        JsonObject image = new JsonObject();
        image.addProperty("format", "png");
        image.addProperty("encoding", "base64");
        int[] dims = pngDimensions(png);
        if (dims != null) {
            image.addProperty("width", dims[0]);
            image.addProperty("height", dims[1]);
        }
        image.addProperty("data", Base64.getEncoder().encodeToString(png));
        JsonObject result = new JsonObject();
        result.addProperty("ok", true);
        result.add("image", image);
        return result;
    }

    private static JsonObject waitForScreen(ClientBridge bridge, JsonObject params)
            throws McTestException {
        JsonObject match = optObject(params, "match");
        long timeoutMs = timeoutMs(params, DEFAULT_TIMEOUT_MS);
        long deadline = System.currentTimeMillis() + timeoutMs;
        ScreenSnapshot snap;
        do {
            snap = bridge.snapshot();
            if (screenMatches(snap, match)) {
                JsonObject result = new JsonObject();
                result.addProperty("ok", true);
                result.add("screen", snap.toJson());
                return result;
            }
            sleep(POLL_INTERVAL_MS);
        } while (System.currentTimeMillis() < deadline);
        throw McTestException.timeout("No matching screen transition within " + timeoutMs + "ms");
    }

    private static JsonObject close(ClientBridge bridge, EventBus events, McTestSession session) {
        boolean was = bridge.closeScreen();
        if (was) {
            emitScreenChanged(bridge, events, session, "closed");
        }
        JsonObject result = new JsonObject();
        result.addProperty("ok", true);
        result.addProperty("screenChanged", was);
        return result;
    }

    // --- client-side world.* ---

    private static JsonObject runCommand(ClientBridge bridge, JsonObject params) {
        bridge.runCommand(stripLeadingSlash(optString(params, "command")));
        JsonObject result = new JsonObject();
        result.addProperty("ok", true);
        result.addProperty("screenChanged", false);
        return result;
    }

    private static JsonObject sendChat(ClientBridge bridge, JsonObject params) {
        String message = optString(params, "message");
        bridge.sendChat(message != null ? message : "");
        JsonObject result = new JsonObject();
        result.addProperty("ok", true);
        return result;
    }

    private static JsonObject waitForChat(ClientBridge bridge, JsonObject params)
            throws McTestException {
        // Pre-parse the filter ONCE (a bad client regex is invalidParams, not an agent-internal error,
        // and the pattern must not recompile per line per poll iteration).
        ChatFilter filter = ChatFilter.from(optObject(params, "filter"));
        long timeoutMs = timeoutMs(params, DEFAULT_TIMEOUT_MS);
        long deadline = System.currentTimeMillis() + timeoutMs;
        do {
            List<String> chat = bridge.recentChat();
            String line = matchChat(chat, filter);
            if (line != null) {
                JsonObject chatObj = new JsonObject();
                chatObj.addProperty("text", line);
                chatObj.addProperty("plain", line);
                chatObj.addProperty("raw", line);
                JsonObject result = new JsonObject();
                result.addProperty("ok", true);
                result.add("chat", chatObj);
                return result;
            }
            sleep(POLL_INTERVAL_MS);
        } while (System.currentTimeMillis() < deadline);
        throw McTestException.timeout("Timed out waiting for chat within " + timeoutMs + "ms");
    }

    // --- selector resolution / matching helpers ---

    /** Resolve exactly one element; 0 → ELEMENT_NOT_FOUND, &gt;1 w/o nth/index → AMBIGUOUS_SELECTOR. */
    private static Element resolveOne(ScreenSnapshot snap, JsonObject selector) throws McTestException {
        List<Element> matches = SelectorMatch.match(snap.elements, selector);
        if (matches.isEmpty()) {
            throw McTestException.elementNotFound(selector);
        }
        if (matches.size() > 1) {
            JsonArray arr = new JsonArray();
            for (Element m : matches) {
                arr.add(m.elementId);
            }
            throw McTestException.ambiguous(arr);
        }
        return matches.get(0);
    }

    /** @return the first present selector key (in {@link #VIA_KEYS} order), or {@code null}. */
    private static String via(JsonObject selector) {
        if (selector == null) {
            return null;
        }
        for (String key : VIA_KEYS) {
            if (selector.has(key)) {
                return key;
            }
        }
        return null;
    }

    /**
     * Title=contains (normalized), {@code kind}/{@code screenId} exact, {@code screenIdPrefix} prefix.
     * A null/empty {@code match} matches any open screen.
     */
    private static boolean screenMatches(ScreenSnapshot snap, JsonObject match) {
        if (match == null || match.size() == 0) {
            return true;
        }
        // Canonical wire key is `title` with contains semantics (PROTOCOL.md §7.2): the runner
        // translates the authoring `titleContains` → `title` before sending, so `title` MUST be the
        // key honored here (the headless driver does the same). `titleContains` is kept as a tolerated
        // alias for a direct caller, but reading only `titleContains` would silently drop the runner's
        // title constraint and match ANY open screen — a false positive.
        String titleNeedle = match.has("title") ? str(match, "title")
                : (match.has("titleContains") ? str(match, "titleContains") : null);
        if (titleNeedle != null) {
            String hay = SelectorMatch.normalize(snap.title);
            if (!hay.contains(SelectorMatch.normalize(titleNeedle))) {
                return false;
            }
        }
        if (match.has("kind")) {
            if (snap.kind == null || !snap.kind.equals(str(match, "kind"))) {
                return false;
            }
        }
        if (match.has("screenId")) {
            if (snap.screenId == null || !snap.screenId.equals(str(match, "screenId"))) {
                return false;
            }
        }
        if (match.has("screenIdPrefix")) {
            String prefix = str(match, "screenIdPrefix");
            if (snap.screenId == null || prefix == null || !snap.screenId.startsWith(prefix)) {
                return false;
            }
        }
        return true;
    }

    /** @return the first chat line satisfying the pre-parsed filter, or null. */
    private static String matchChat(List<String> chat, ChatFilter filter) {
        if (chat == null) {
            return null;
        }
        for (String line : chat) {
            if (filter.matches(line)) {
                return line;
            }
        }
        return null;
    }

    /**
     * A pre-parsed {@code world.waitForChat} filter: a normalized {@code contains} needle and/or a
     * compiled {@code regex}. Compiled ONCE per call (a malformed client regex throws
     * {@code -32602 invalidParams}, never the agent-internal {@code -32603}), then reused across every
     * line and poll iteration. {@code contains} takes precedence over {@code regex} when both are given.
     */
    private static final class ChatFilter {
        private final String containsNeedle; // normalized, or null
        private final Pattern regex;         // wrapped .*(?:…).*, or null

        private ChatFilter(String containsNeedle, Pattern regex) {
            this.containsNeedle = containsNeedle;
            this.regex = regex;
        }

        static ChatFilter from(JsonObject filter) throws McTestException {
            if (filter == null || filter.size() == 0) {
                return new ChatFilter(null, null);
            }
            String contains = filter.has("contains")
                    ? SelectorMatch.normalize(str(filter, "contains")) : null;
            Pattern pattern = null;
            if (contains == null && filter.has("regex")) {
                String raw = str(filter, "regex");
                if (raw != null) {
                    try {
                        pattern = Pattern.compile(".*(?:" + raw + ").*");
                    } catch (PatternSyntaxException e) {
                        throw McTestException.invalidParams(
                                "Invalid world.waitForChat regex: " + e.getMessage());
                    }
                }
            }
            return new ChatFilter(contains, pattern);
        }

        boolean matches(String line) {
            if (line == null) {
                return false;
            }
            if (containsNeedle == null && regex == null) {
                return true; // no filter → first line counts as a match.
            }
            if (containsNeedle != null) {
                return SelectorMatch.normalize(line).contains(containsNeedle);
            }
            return regex.matcher(line).matches();
        }
    }

    private static void emitScreenChanged(ClientBridge bridge, EventBus events, McTestSession session,
            String change) {
        if (events == null) {
            return;
        }
        // Canonical event.screenChanged payload (PROTOCOL.md §3.6 / §7.6): params carry the sessionId
        // and a data object { change, screenId, kind, title } (screenId null when closed to world).
        ScreenSnapshot snap = bridge.snapshot();
        JsonObject data = new JsonObject();
        data.addProperty("change", change);
        if (snap.screenId != null) {
            data.addProperty("screenId", snap.screenId);
        } else {
            data.add("screenId", com.google.gson.JsonNull.INSTANCE);
        }
        if (snap.kind != null) {
            data.addProperty("kind", snap.kind);
        }
        if (snap.title != null) {
            data.addProperty("title", snap.title);
        }
        JsonObject params = new JsonObject();
        if (session != null) {
            params.addProperty("sessionId", session.id);
        }
        params.add("data", data);
        events.emit("event.screenChanged", params);
    }

    // --- small param helpers (Gson-only; mirror Bukkit Params style) ---

    private static String stripLeadingSlash(String command) {
        if (command == null) {
            return "";
        }
        return command.startsWith("/") ? command.substring(1) : command;
    }

    private static JsonObject optObject(JsonObject p, String key) {
        if (p != null && p.has(key) && p.get(key).isJsonObject()) {
            return p.getAsJsonObject(key);
        }
        return null;
    }

    private static String optString(JsonObject p, String key) {
        if (p != null && p.has(key) && p.get(key).isJsonPrimitive()) {
            return p.get(key).getAsString();
        }
        return null;
    }

    private static boolean optBoolean(JsonObject p, String key, boolean def) {
        if (p != null && p.has(key) && p.get(key).isJsonPrimitive()
                && p.getAsJsonPrimitive(key).isBoolean()) {
            return p.get(key).getAsBoolean();
        }
        return def;
    }

    private static long timeoutMs(JsonObject p, long def) {
        if (p != null && p.has("timeoutMs") && p.get("timeoutMs").isJsonPrimitive()
                && p.getAsJsonPrimitive("timeoutMs").isNumber()) {
            long v = p.get("timeoutMs").getAsLong();
            if (v > 0) {
                return v;
            }
        }
        return def;
    }

    private static java.util.List<String> stringList(JsonObject p, String key) {
        java.util.List<String> out = new java.util.ArrayList<>();
        if (p != null && p.has(key) && p.get(key).isJsonArray()) {
            for (JsonElement el : p.getAsJsonArray(key)) {
                if (el.isJsonPrimitive()) {
                    out.add(el.getAsString());
                }
            }
        }
        return out;
    }

    private static String str(JsonObject o, String key) {
        JsonElement el = o.get(key);
        return el != null && el.isJsonPrimitive() ? el.getAsString() : null;
    }

    /** Reads width/height from a PNG IHDR header (big-endian at byte offsets 16/20), or null if not a PNG. */
    private static int[] pngDimensions(byte[] png) {
        if (png == null || png.length < 24) {
            return null;
        }
        int width = ((png[16] & 0xff) << 24) | ((png[17] & 0xff) << 16)
                | ((png[18] & 0xff) << 8) | (png[19] & 0xff);
        int height = ((png[20] & 0xff) << 24) | ((png[21] & 0xff) << 16)
                | ((png[22] & 0xff) << 8) | (png[23] & 0xff);
        if (width <= 0 || height <= 0) {
            return null;
        }
        return new int[] {width, height};
    }

    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
