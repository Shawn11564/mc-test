package io.mctest.agent.core;

import com.google.gson.JsonObject;

/**
 * Broadcasts {@code event.*} JSON-RPC notifications to connected clients (PROTOCOL.md §3.6). The
 * actual fan-out target is supplied by {@link MctpServer} as a {@link Broadcaster}; handlers call
 * {@link #emit} to push chat/log/screen events without knowing the transport.
 */
public final class EventBus {

    /** Transport seam: serialize and send one notification frame to all connected clients. */
    public interface Broadcaster {
        void broadcast(String frame);
    }

    private volatile Broadcaster broadcaster;

    public EventBus() {
    }

    public EventBus(Broadcaster broadcaster) {
        this.broadcaster = broadcaster;
    }

    /** Wires the transport target (called by {@link MctpServer} on construction). */
    public void setBroadcaster(Broadcaster broadcaster) {
        this.broadcaster = broadcaster;
    }

    /**
     * Emits a JSON-RPC notification with the given {@code event.*} method and params (no id, §3.6).
     * No-op if no broadcaster is wired.
     */
    public void emit(String method, JsonObject params) {
        Broadcaster b = this.broadcaster;
        if (b == null) {
            return;
        }
        JsonObject envelope = JsonRpc.notification(method, params);
        b.broadcast(envelope.toString());
    }
}
