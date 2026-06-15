package io.mctest.agent.core;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.Test;

/**
 * Unit test for the ADDITIVE {@code world.join}/{@code world.leave} hook on {@link Dispatch}
 * (M4 client layer). Proves the two paths:
 * <ul>
 *   <li><b>hook set</b> (client agent): {@code world.join} runs the hook, merges its returned fields
 *       (e.g. {@code playerName}) into the result, and transitions to {@code connected};</li>
 *   <li><b>no hook</b> (server agent): {@code world.join} is byte-for-byte the existing no-op —
 *       {@code playerName} null + {@code serverBrand} present — so the M3 {@code ConformanceTest}
 *       stays green.</li>
 * </ul>
 * Exercises {@link Dispatch} directly (no WebSocket) via a per-connection {@link Dispatch.ConnectionState}.
 */
class DispatchWorldHookTest {

    @Test
    void joinHookFiresAndMergesPlayerName() throws Exception {
        AtomicBoolean joinCalled = new AtomicBoolean(false);
        AtomicBoolean leaveCalled = new AtomicBoolean(false);

        Dispatch dispatch = baseDispatch();
        dispatch.setJoinHook((session, params) -> {
            joinCalled.set(true);
            String username = params.has("username") ? params.get("username").getAsString() : null;
            JsonObject extra = new JsonObject();
            extra.addProperty("playerName", username != null ? username : "");
            return extra;
        });
        dispatch.setLeaveHook((session, params) -> {
            leaveCalled.set(true);
            return new JsonObject();
        });

        Dispatch.ConnectionState conn = new Dispatch.ConnectionState();
        String sessionId = createSession(dispatch, conn);

        JsonObject joinParams = new JsonObject();
        joinParams.addProperty("sessionId", sessionId);
        joinParams.addProperty("host", "localhost");
        joinParams.addProperty("port", 25565);
        joinParams.addProperty("username", "Tester");
        JsonObject joinResult = dispatch.dispatch("world.join", joinParams, conn);

        assertTrue(joinCalled.get(), "join hook must fire");
        assertTrue(joinResult.get("ok").getAsBoolean());
        assertEquals("Tester", joinResult.get("playerName").getAsString());
        // The no-op-only serverBrand field is NOT added on the hook path.
        assertFalse(joinResult.has("serverBrand"));
        assertEquals(McTestSession.STATE_CONNECTED, conn.session.state);

        JsonObject leaveParams = new JsonObject();
        leaveParams.addProperty("sessionId", sessionId);
        JsonObject leaveResult = dispatch.dispatch("world.leave", leaveParams, conn);
        assertTrue(leaveCalled.get(), "leave hook must fire");
        assertTrue(leaveResult.get("ok").getAsBoolean());
        assertEquals(McTestSession.STATE_READY, conn.session.state);
    }

    @Test
    void noHookKeepsServerNoOp() throws Exception {
        Dispatch dispatch = baseDispatch(); // no join/leave hook installed.

        Dispatch.ConnectionState conn = new Dispatch.ConnectionState();
        String sessionId = createSession(dispatch, conn);

        JsonObject joinParams = new JsonObject();
        joinParams.addProperty("sessionId", sessionId);
        JsonObject joinResult = dispatch.dispatch("world.join", joinParams, conn);

        // Server no-op: playerName null + serverBrand present (identical to pre-M4 behavior).
        assertTrue(joinResult.get("ok").getAsBoolean());
        assertTrue(joinResult.get("playerName").isJsonNull());
        assertTrue(joinResult.has("serverBrand"));
        assertEquals(McTestSession.STATE_CONNECTED, conn.session.state);
    }

    // --- helpers ---

    private static Dispatch baseDispatch() {
        Capabilities caps = new Capabilities().advertise("chat").advertise("clientScreens");
        return new Dispatch()
                .setAgentInfo("mc-test-agent", "0.1.0", "clientMod", "java")
                .setCapabilities(caps)
                .setTargetInfo("1.21.1", "fabric", "0.16.0");
    }

    private static String createSession(Dispatch dispatch, Dispatch.ConnectionState conn)
            throws Exception {
        JsonObject params = new JsonObject();
        params.addProperty("protocolVersion", "1.0");
        JsonArray required = new JsonArray();
        required.add("chat");
        params.add("requiredCapabilities", required);
        JsonObject result = dispatch.dispatch("session.create", params, conn);
        return result.get("sessionId").getAsString();
    }
}
