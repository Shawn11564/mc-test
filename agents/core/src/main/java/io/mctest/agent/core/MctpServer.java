package io.mctest.agent.core;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.net.InetSocketAddress;
import java.util.Collections;
import java.util.List;
import org.java_websocket.WebSocket;
import org.java_websocket.drafts.Draft;
import org.java_websocket.drafts.Draft_6455;
import org.java_websocket.exceptions.InvalidDataException;
import org.java_websocket.handshake.ClientHandshake;
import org.java_websocket.handshake.ServerHandshakeBuilder;
import org.java_websocket.protocols.IProtocol;
import org.java_websocket.protocols.Protocol;
import org.java_websocket.server.WebSocketServer;

/**
 * The MCTP WebSocket server (PROTOCOL.md §2). Accepts only sub-protocol {@code mctp.v1} on path
 * {@code /mctp}, parses each text frame as one JSON-RPC envelope, routes it through {@link Dispatch},
 * and writes back a success/error envelope echoing {@code id}. Exposes an {@link EventBus} for pushing
 * {@code event.*} notifications. The transport is NOT swappable — it is the contract.
 */
public final class MctpServer extends WebSocketServer {

    private final Dispatch dispatch;
    private final LogSink log;
    private final EventBus events;
    private final int port;
    private volatile boolean started;

    public MctpServer(String host, int port, Dispatch dispatch, LogSink log) {
        super(new InetSocketAddress(host, port), buildDrafts());
        this.dispatch = dispatch;
        this.log = log != null ? log : (level, message) -> {
        };
        this.port = port;
        this.events = new EventBus(this::broadcastFrame);
        // Surface bind problems promptly instead of hanging.
        setReuseAddr(true);
    }

    /** The event bus for pushing {@code event.*} notifications to connected clients. */
    public EventBus events() {
        return events;
    }

    /**
     * Start accepting MCTP connections (binds the port; non-blocking — {@link #onStart()} logs once
     * bound). Exposed as a first-class method so downstream agents drive the server without depending
     * on the Java-WebSocket {@code WebSocketServer} supertype directly.
     */
    public void startMctp() {
        start();
    }

    /** Stop the server and release the port (idempotent-friendly; swallows the interrupt as a stop). */
    public void stopMctp() {
        try {
            stop();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    /** Restricts the accepted sub-protocol to {@code mctp.v1} (PROTOCOL.md §2.1). */
    private static List<Draft> buildDrafts() {
        IProtocol protocol = new Protocol(MctpProtocol.SUBPROTOCOL);
        return Collections.singletonList(new Draft_6455(Collections.emptyList(),
                Collections.singletonList(protocol)));
    }

    @Override
    public ServerHandshakeBuilder onWebsocketHandshakeReceivedAsServer(
            WebSocket conn, Draft draft, ClientHandshake request) throws InvalidDataException {
        // Enforce the /mctp path. Draft_6455 already rejects connections lacking the mctp.v1
        // sub-protocol (no other protocol is offered), per PROTOCOL.md §2.1.
        ServerHandshakeBuilder builder = super.onWebsocketHandshakeReceivedAsServer(conn, draft, request);
        String resource = request.getResourceDescriptor();
        String path = resource;
        if (path != null) {
            int q = path.indexOf('?');
            if (q >= 0) {
                path = path.substring(0, q);
            }
        }
        if (path == null || !MctpProtocol.PATH.equals(path)) {
            throw new InvalidDataException(org.java_websocket.framing.CloseFrame.POLICY_VALIDATION,
                    "MCTP serves only " + MctpProtocol.PATH);
        }
        return builder;
    }

    @Override
    public void onStart() {
        started = true;
        log.log("INFO", "MCTP listening on :" + port);
    }

    @Override
    public void onOpen(WebSocket conn, ClientHandshake handshake) {
        // One connection hosts at most one session; attach a fresh ConnectionState (PROTOCOL.md §2.4).
        conn.setAttachment(new Dispatch.ConnectionState());
    }

    @Override
    public void onClose(WebSocket conn, int code, String reason, boolean remote) {
        // Closing the socket implicitly ends any open session (PROTOCOL.md §2.4 / §4.4).
        Dispatch.ConnectionState state = conn.getAttachment();
        if (state != null && state.session != null) {
            dispatch.closeSession(state.session);
            state.session = null;
        }
    }

    @Override
    public void onMessage(WebSocket conn, String message) {
        JsonElement id = null;
        try {
            JsonObject envelope = JsonRpc.parse(message);
            id = envelope.has("id") ? envelope.get("id") : null;

            if (!JsonRpc.VERSION.equals(stringOrNull(envelope, "jsonrpc"))) {
                throw new McTestException(Errors.INVALID_REQUEST, Errors.REASON_INVALID_REQUEST,
                        "Missing or wrong jsonrpc version");
            }
            String method = stringOrNull(envelope, "method");
            if (method == null) {
                throw new McTestException(Errors.INVALID_REQUEST, Errors.REASON_INVALID_REQUEST,
                        "Missing method");
            }
            JsonObject params = envelope.has("params") && envelope.get("params").isJsonObject()
                    ? envelope.getAsJsonObject("params") : new JsonObject();

            Dispatch.ConnectionState state = conn.getAttachment();
            if (state == null) {
                state = new Dispatch.ConnectionState();
                conn.setAttachment(state);
            }

            JsonObject result = dispatch.dispatch(method, params, state);
            conn.send(JsonRpc.success(id, result).toString());
        } catch (McTestException e) {
            conn.send(JsonRpc.error(id, e).toString());
        } catch (RuntimeException e) {
            log.log("ERROR", "Internal error handling frame: " + e);
            McTestException internal = McTestException.internal(
                    "Internal agent error: " + e.getClass().getSimpleName());
            conn.send(JsonRpc.error(id, internal).toString());
        }
    }

    @Override
    public void onError(WebSocket conn, Exception ex) {
        log.log("ERROR", "WebSocket error: " + ex);
    }

    /** Broadcasts a raw notification frame to every open connection (used by {@link EventBus}). */
    private void broadcastFrame(String frame) {
        broadcast(frame);
    }

    public boolean isStarted() {
        return started;
    }

    public int getMctpPort() {
        return port;
    }

    private static String stringOrNull(JsonObject o, String key) {
        return o.has(key) && o.get(key).isJsonPrimitive() ? o.get(key).getAsString() : null;
    }
}
