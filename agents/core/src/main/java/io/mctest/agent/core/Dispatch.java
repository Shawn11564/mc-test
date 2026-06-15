package io.mctest.agent.core;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

/**
 * The method router and session/capability state machine (PROTOCOL.md §4–§5, §9). The core handles
 * the universal {@code session.*} and {@code world.join}/{@code world.leave} group itself; every other
 * method is a registered {@link PrimitiveHandler} gated by an optional required-capability key. All
 * intelligence (negotiation, capability gating, error mapping) lives here so per-loader shims stay dumb.
 */
public final class Dispatch {

    /** Per-connection state: the one session this socket currently hosts (PROTOCOL.md §2.4). */
    public static final class ConnectionState {
        /** The active session, or null in the Disconnected state. */
        public volatile McTestSession session;
    }

    private static final class Registration {
        final String requiredCap; // null = no capability gate.
        final PrimitiveHandler handler;

        Registration(String requiredCap, PrimitiveHandler handler) {
            this.requiredCap = requiredCap;
            this.handler = handler;
        }
    }

    /**
     * Optional per-agent override for {@code world.join}/{@code world.leave} (ADDITIVE, PROTOCOL.md §7.1).
     * A server agent sets no hook → the built-in no-op runs (playerName null + serverBrand). A client
     * agent sets a hook that connects/disconnects the real client via its {@code ClientBridge} and may
     * merge extra fields (e.g. {@code playerName}) into the result.
     */
    public interface WorldHook {
        com.google.gson.JsonObject onWorld(McTestSession s, com.google.gson.JsonObject p)
                throws McTestException;
    }

    private final Map<String, Registration> handlers = new LinkedHashMap<>();
    private final Map<String, McTestSession> sessions = new ConcurrentHashMap<>();
    private final AtomicLong sessionCounter = new AtomicLong();

    private WorldHook joinHook;  // nullable; null = built-in server no-op.
    private WorldHook leaveHook; // nullable; null = built-in server no-op.

    private Capabilities capabilities = new Capabilities();
    private String agentName = "mc-test-agent";
    private String agentVersion = "0.1.0";
    private String agentKind = "serverPlugin";
    private String agentLang = "java";

    private String targetMinecraft;
    private String targetLoader;
    private String targetLoaderVersion;

    private LogSink log = (level, message) -> {
    };

    // --- Configuration (set once at startup) ---

    public Dispatch setAgentInfo(String name, String version, String kind, String lang) {
        this.agentName = name;
        this.agentVersion = version;
        this.agentKind = kind;
        this.agentLang = lang;
        return this;
    }

    public Dispatch setCapabilities(Capabilities capabilities) {
        this.capabilities = capabilities != null ? capabilities : new Capabilities();
        return this;
    }

    public Dispatch setTargetInfo(String minecraft, String loader, String loaderVersion) {
        this.targetMinecraft = minecraft;
        this.targetLoader = loader;
        this.targetLoaderVersion = loaderVersion;
        return this;
    }

    public Dispatch setLogSink(LogSink log) {
        if (log != null) {
            this.log = log;
        }
        return this;
    }

    /** Installs the {@code world.join} override (ADDITIVE); {@code null} keeps the built-in no-op. */
    public Dispatch setJoinHook(WorldHook h) {
        this.joinHook = h;
        return this;
    }

    /** Installs the {@code world.leave} override (ADDITIVE); {@code null} keeps the built-in no-op. */
    public Dispatch setLeaveHook(WorldHook h) {
        this.leaveHook = h;
        return this;
    }

    /**
     * Registers a primitive handler for {@code method}, optionally gated by a required capability key
     * (ungranted advertised method → {@code -32002}). Pass {@code null} for an ungated method.
     */
    public Dispatch register(String method, String requiredCapKeyOrNull, PrimitiveHandler handler) {
        handlers.put(method, new Registration(requiredCapKeyOrNull, handler));
        return this;
    }

    // --- Dispatch entry point ---

    /**
     * Routes one request to its handler and returns the {@code result} object, or throws
     * {@link McTestException} for any error. Handles the universal session/world group internally.
     */
    public JsonObject dispatch(String method, JsonObject params, ConnectionState conn) throws McTestException {
        if (method == null) {
            throw new McTestException(Errors.METHOD_NOT_FOUND, Errors.REASON_METHOD_NOT_FOUND,
                    "Missing method");
        }
        JsonObject p = params != null ? params : new JsonObject();

        switch (method) {
            case "session.describe":
                return describe();
            case "session.ping":
                return ping(p);
            case "session.create":
                return create(p, conn);
            case "session.close":
                return close(p, conn);
            case "world.join":
                return worldJoin(p, requireSession(p, conn));
            case "world.leave":
                return worldLeave(p, requireSession(p, conn));
            default:
                return dispatchRegisteredMethod(method, p, conn);
        }
    }

    private JsonObject dispatchRegisteredMethod(String method, JsonObject p, ConnectionState conn)
            throws McTestException {
        Registration reg = handlers.get(method);
        if (reg == null) {
            throw new McTestException(Errors.METHOD_NOT_FOUND, Errors.REASON_METHOD_NOT_FOUND,
                    "Unknown method: " + method);
        }
        McTestSession session = requireSession(p, conn);
        // Capability gating: ungranted advertised method → -32002 METHOD_NOT_SUPPORTED.
        if (reg.requiredCap != null && !session.grants(reg.requiredCap)) {
            throw McTestException.methodNotSupported(
                    "Capability not granted for " + method + ": " + reg.requiredCap);
        }
        return reg.handler.handle(session, p);
    }

    // --- session.* group ---

    private JsonObject describe() {
        JsonObject result = new JsonObject();
        result.addProperty("ok", true);
        result.addProperty("protocolVersion", MctpProtocol.VERSION);
        JsonArray supported = new JsonArray();
        for (String v : MctpProtocol.SUPPORTED_PROTOCOLS) {
            supported.add(v);
        }
        result.add("supportedProtocols", supported);
        JsonObject agent = new JsonObject();
        agent.addProperty("name", agentName);
        agent.addProperty("version", agentVersion);
        agent.addProperty("kind", agentKind);
        result.add("agent", agent);
        result.add("capabilities", capabilities.advertisedArray());
        return result;
    }

    private JsonObject ping(JsonObject p) {
        JsonObject result = new JsonObject();
        result.addProperty("ok", true);
        if (p.has("nonce")) {
            result.add("nonce", p.get("nonce"));
        }
        // serverTick is optional; agents with a game clock populate it. Omitted here.
        return result;
    }

    private JsonObject create(JsonObject p, ConnectionState conn) throws McTestException {
        // 1. protocol-version major check.
        String requested = p.has("protocolVersion") ? p.get("protocolVersion").getAsString() : null;
        if (requested == null || !MctpProtocol.isMajorSupported(requested)) {
            throw McTestException.protocolUnsupported(
                    "Unsupported protocol version: " + requested);
        }

        // 2. target-descriptor constraints (loader / mcVersionRange). An unsatisfiable constraint
        //    refuses with no session created (PROTOCOL.md §5.1 step 2 / §5.3).
        McTestException constraintMiss = checkConstraints(p);
        if (constraintMiss != null) {
            throw constraintMiss;
        }

        // 3. negotiate required/optional capabilities.
        List<String> required = stringList(p, "requiredCapabilities");
        List<String> optional = stringList(p, "optionalCapabilities");
        Capabilities.Negotiation neg = capabilities.negotiate(required, optional);
        if (!neg.satisfied) {
            // Refuse: no session created (PROTOCOL.md §5.1/§5.3).
            throw McTestException.methodNotSupported(neg.unmet, neg.offered);
        }

        // 4. create the session bound to this connection.
        String sessionId = "s_" + Long.toHexString(sessionCounter.incrementAndGet()) + "_"
                + Long.toHexString(System.nanoTime() & 0xffffff);
        McTestSession session = new McTestSession(sessionId, new java.util.LinkedHashSet<>(neg.granted));
        sessions.put(sessionId, session);
        conn.session = session;

        JsonObject result = new JsonObject();
        result.addProperty("ok", true);
        result.addProperty("sessionId", sessionId);
        result.addProperty("protocolVersion", MctpProtocol.VERSION);

        JsonObject agent = new JsonObject();
        agent.addProperty("name", agentName);
        agent.addProperty("version", agentVersion);
        agent.addProperty("kind", agentKind);
        agent.addProperty("lang", agentLang);
        result.add("agent", agent);

        JsonObject target = new JsonObject();
        if (targetMinecraft != null) {
            target.addProperty("minecraft", targetMinecraft);
        }
        if (targetLoader != null) {
            target.addProperty("loader", targetLoader);
        }
        if (targetLoaderVersion != null) {
            target.addProperty("loaderVersion", targetLoaderVersion);
        }
        result.add("target", target);

        result.add("grantedCapabilities", toArray(neg.granted));
        result.add("deniedCapabilities", toArray(neg.denied));
        result.add("capabilityDetails", neg.grantedDetails);
        return result;
    }

    private JsonObject close(JsonObject p, ConnectionState conn) throws McTestException {
        McTestSession session = requireSession(p, conn);
        // Release per-session resources (fixtures, fake players) before invalidating.
        session.resources.releaseAll();
        session.state = McTestSession.STATE_CLOSED;
        sessions.remove(session.id);
        if (conn != null && conn.session == session) {
            conn.session = null;
        }
        JsonObject result = new JsonObject();
        result.addProperty("ok", true);
        return result;
    }

    // --- world.join / world.leave group ---

    private JsonObject worldJoin(JsonObject p, McTestSession session) throws McTestException {
        // Transition Ready → Connected either way (PROTOCOL.md §4.1).
        session.state = McTestSession.STATE_CONNECTED;
        if (joinHook != null) {
            // Client agent: connect the real client, then merge any returned fields (e.g. playerName)
            // over the base result.
            JsonObject result = new JsonObject();
            result.addProperty("ok", true);
            JsonObject extra = joinHook.onWorld(session, p);
            if (extra != null) {
                for (Map.Entry<String, JsonElement> e : extra.entrySet()) {
                    result.add(e.getKey(), e.getValue());
                }
            }
            return result;
        }
        // Server-side agent (no hook): world.join is a no-op (playerName null + serverBrand).
        JsonObject result = new JsonObject();
        result.addProperty("ok", true);
        result.add("playerName", com.google.gson.JsonNull.INSTANCE);
        result.addProperty("serverBrand", agentName);
        return result;
    }

    private JsonObject worldLeave(JsonObject p, McTestSession session) throws McTestException {
        if (leaveHook != null) {
            leaveHook.onWorld(session, p);
        }
        session.state = McTestSession.STATE_READY;
        JsonObject result = new JsonObject();
        result.addProperty("ok", true);
        return result;
    }

    // --- helpers ---

    /** Resolves the session for a stateful call; unknown/closed/missing → -32602 (PROTOCOL.md §3.2). */
    private McTestSession requireSession(JsonObject p, ConnectionState conn) throws McTestException {
        String sessionId = p.has("sessionId") && p.get("sessionId").isJsonPrimitive()
                ? p.get("sessionId").getAsString() : null;
        if (sessionId == null) {
            throw McTestException.invalidParams("Missing sessionId");
        }
        McTestSession session = sessions.get(sessionId);
        if (session == null || session.isClosed()) {
            throw McTestException.invalidParams("Unknown or closed session: " + sessionId);
        }
        // Enforce the one-session-per-connection invariant (PROTOCOL.md §2.4): the sessionId MUST
        // belong to THIS connection. A connection that never ran session.create owns no session, and
        // one socket may not drive another socket's session.
        if (conn != null) {
            if (conn.session == null) {
                throw McTestException.invalidParams(
                        "No session on this connection; session.create must come first");
            }
            if (conn.session != session) {
                throw McTestException.invalidParams(
                        "sessionId does not belong to this connection: " + sessionId);
            }
        }
        return session;
    }

    /**
     * Evaluates {@code params.constraints} against the configured target (PROTOCOL.md §5.1 step 2):
     * a {@code loader} mismatch or an out-of-range {@code mcVersionRange} refuses the handshake.
     * Returns the refusal exception, or {@code null} when every constraint is satisfied (or absent).
     */
    private McTestException checkConstraints(JsonObject p) {
        if (!p.has("constraints") || !p.get("constraints").isJsonObject()) {
            return null;
        }
        JsonObject c = p.getAsJsonObject("constraints");
        if (c.has("loader") && c.get("loader").isJsonPrimitive() && targetLoader != null) {
            String wantLoader = c.get("loader").getAsString();
            if (!targetLoader.equalsIgnoreCase(wantLoader)) {
                return McTestException.constraintUnsatisfied("loader",
                        "Target loader '" + targetLoader + "' does not satisfy constraint '" + wantLoader + "'");
            }
        }
        if (c.has("mcVersionRange") && c.get("mcVersionRange").isJsonPrimitive() && targetMinecraft != null) {
            String range = c.get("mcVersionRange").getAsString();
            if (!VersionRange.satisfies(targetMinecraft, range)) {
                return McTestException.constraintUnsatisfied("mcVersionRange",
                        "Target version '" + targetMinecraft + "' does not satisfy constraint '" + range + "'");
            }
        }
        return null;
    }

    /** Runs every open session's cleanups (called by the server on socket close). */
    public void closeSession(McTestSession session) {
        if (session == null) {
            return;
        }
        session.resources.releaseAll();
        session.state = McTestSession.STATE_CLOSED;
        sessions.remove(session.id);
    }

    private static List<String> stringList(JsonObject p, String key) {
        List<String> out = new ArrayList<>();
        if (p.has(key) && p.get(key).isJsonArray()) {
            for (JsonElement el : p.getAsJsonArray(key)) {
                if (el.isJsonPrimitive()) {
                    out.add(el.getAsString());
                }
            }
        }
        return out;
    }

    private static JsonArray toArray(List<String> values) {
        JsonArray arr = new JsonArray();
        for (String v : values) {
            arr.add(v);
        }
        return arr;
    }
}
