package io.mctest.agent.core.client;

import com.google.gson.JsonObject;
import io.mctest.agent.core.Capabilities;
import io.mctest.agent.core.Dispatch;
import io.mctest.agent.core.EventBus;

/**
 * Assembly helper so the per-loader client shim ({@code /agents/client-fabric} etc.) stays trivial: it
 * wires a {@link Dispatch} for a client agent from a {@link ClientBridge}. Capabilities come from
 * {@link ClientCapabilities#build(boolean)} keyed on {@code bridge.hasFramebuffer()}; the {@code screen.*}
 * + client {@code world.*} handlers are registered via {@link ScreenHandlers}; and the Dispatch
 * world-join/leave hooks route to {@code bridge.joinServer}/{@code leaveServer} (the client connect that
 * a server agent's {@code world.join} no-op does NOT do).
 *
 * <p>The caller (the loader shim) constructs the {@code MctpServer(host, port, dispatch, log)} and
 * {@code start()}s it. To share the server's {@link EventBus} so {@code event.screenChanged} reaches
 * connected clients, pass {@code server.events()} as {@code events} after constructing the server, or
 * pass a fresh {@code EventBus} that the same server broadcasts through (see the shim wiring note).
 */
public final class ClientAgent {

    private ClientAgent() {
    }

    /**
     * Build a {@link Dispatch} wired for a client agent: capabilities from {@code bridge.hasFramebuffer()},
     * {@link ScreenHandlers#register} against {@code events}, and join/leave hooks → {@code bridge.joinServer}
     * /{@code bridge.leaveServer}. The caller constructs and starts the {@code MctpServer}.
     */
    public static Dispatch buildDispatch(ClientBridge bridge, EventBus events, String agentName,
            String agentKind, String mcVersion, String loader, String loaderVersion) {
        Capabilities caps = ClientCapabilities.build(bridge.hasFramebuffer());

        Dispatch dispatch = new Dispatch()
                .setAgentInfo(agentName, "0.1.0", agentKind, "java")
                .setCapabilities(caps)
                .setTargetInfo(mcVersion, loader, loaderVersion);

        // world.join → connect the client to the SUT server; world.leave → disconnect.
        dispatch.setJoinHook((session, params) -> {
            String host = optString(params, "host");
            int port = optInt(params, "port", 25565);
            String username = optString(params, "username");
            bridge.joinServer(host, port, username);
            JsonObject extra = new JsonObject();
            extra.addProperty("playerName", username != null ? username : "");
            return extra;
        });
        dispatch.setLeaveHook((session, params) -> {
            bridge.leaveServer();
            return new JsonObject();
        });

        ScreenHandlers.register(dispatch, bridge, events);
        return dispatch;
    }

    private static String optString(JsonObject p, String key) {
        if (p != null && p.has(key) && p.get(key).isJsonPrimitive()) {
            return p.get(key).getAsString();
        }
        return null;
    }

    private static int optInt(JsonObject p, String key, int def) {
        if (p != null && p.has(key) && p.get(key).isJsonPrimitive()
                && p.getAsJsonPrimitive(key).isNumber()) {
            return p.get(key).getAsInt();
        }
        return def;
    }
}
