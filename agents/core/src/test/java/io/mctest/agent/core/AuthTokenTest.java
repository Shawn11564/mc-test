package io.mctest.agent.core;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.junit.jupiter.api.Test;

/**
 * The spec/42 handshake token: when {@link Dispatch#setAuthToken} is configured,
 * {@code session.create} without a matching {@code params.auth.token} is {@code -32602} and NO
 * session exists afterwards (so every stateful method stays unreachable); with the right token the
 * handshake proceeds exactly as before. A tokenless agent must ignore {@code auth} entirely —
 * that is what keeps existing runner flows working on throwaway instances.
 */
class AuthTokenTest {

    private static JsonObject createParams() {
        JsonObject p = new JsonObject();
        p.addProperty("protocolVersion", "1.0");
        p.add("requiredCapabilities", new JsonArray());
        return p;
    }

    private static JsonObject withToken(JsonObject p, String token) {
        JsonObject auth = new JsonObject();
        auth.addProperty("token", token);
        p.add("auth", auth);
        return p;
    }

    private static Dispatch tokenized() {
        return new Dispatch()
                .setAgentInfo("mc-test-agent", "0.1.0", "serverMod", "java")
                .setCapabilities(new Capabilities().advertise("worldTruth"))
                .setAuthToken("s3cret");
    }

    @Test
    void missingTokenIsRefusedWithNoSession() {
        Dispatch dispatch = tokenized();
        Dispatch.ConnectionState conn = new Dispatch.ConnectionState();
        McTestException e = assertThrows(McTestException.class,
                () -> dispatch.dispatch("session.create", createParams(), conn));
        assertEquals(Errors.INVALID_PARAMS, e.code);
        assertEquals(null, conn.session);
    }

    @Test
    void wrongTokenIsRefusedWithNoSession() {
        Dispatch dispatch = tokenized();
        Dispatch.ConnectionState conn = new Dispatch.ConnectionState();
        McTestException e = assertThrows(McTestException.class,
                () -> dispatch.dispatch("session.create", withToken(createParams(), "nope"), conn));
        assertEquals(Errors.INVALID_PARAMS, e.code);
        assertEquals(null, conn.session);
    }

    @Test
    void rightTokenCreatesSession() throws Exception {
        Dispatch dispatch = tokenized();
        Dispatch.ConnectionState conn = new Dispatch.ConnectionState();
        JsonObject result = dispatch.dispatch("session.create",
                withToken(createParams(), "s3cret"), conn);
        assertTrue(result.get("ok").getAsBoolean());
        assertNotNull(result.get("sessionId"));
        assertNotNull(conn.session);
    }

    @Test
    void authCheckRunsBeforeProtocolVersionCheck() {
        // An unauthenticated caller must learn nothing — not even that its protocol version is bad.
        Dispatch dispatch = tokenized();
        JsonObject p = createParams();
        p.addProperty("protocolVersion", "9.9");
        McTestException e = assertThrows(McTestException.class,
                () -> dispatch.dispatch("session.create", p, new Dispatch.ConnectionState()));
        assertEquals(Errors.INVALID_PARAMS, e.code);
    }

    @Test
    void tokenlessAgentIgnoresAuth() throws Exception {
        Dispatch dispatch = new Dispatch()
                .setCapabilities(new Capabilities().advertise("worldTruth"));
        // With no token configured, both an absent and a bogus auth object are accepted.
        JsonObject r1 = dispatch.dispatch("session.create", createParams(),
                new Dispatch.ConnectionState());
        assertTrue(r1.get("ok").getAsBoolean());
        JsonObject r2 = dispatch.dispatch("session.create", withToken(createParams(), "whatever"),
                new Dispatch.ConnectionState());
        assertTrue(r2.get("ok").getAsBoolean());
    }

    @Test
    void emptyConfiguredTokenMeansOpen() throws Exception {
        // setAuthToken("") normalizes to "no token" — an empty env var must not lock the agent.
        Dispatch dispatch = new Dispatch()
                .setCapabilities(new Capabilities())
                .setAuthToken("");
        JsonObject r = dispatch.dispatch("session.create", createParams(),
                new Dispatch.ConnectionState());
        assertTrue(r.get("ok").getAsBoolean());
    }
}
