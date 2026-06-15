package io.mctest.agent.core;

import java.util.ArrayDeque;
import java.util.Collections;
import java.util.Deque;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

/**
 * A negotiated, capability-scoped session bound to one connection (PROTOCOL.md §4). Handlers stash
 * per-session resources (fixtures applied, fake players spawned) as {@link Runnable} cleanups in
 * {@link #resources}; the dispatch layer runs them on {@code session.close} / socket close.
 */
public class McTestSession {

    /** Session state token: {@code "ready"} | {@code "connected"} | {@code "closed"} (PROTOCOL.md §4.1). */
    public static final String STATE_READY = "ready";
    public static final String STATE_CONNECTED = "connected";
    public static final String STATE_CLOSED = "closed";

    /** Opaque session id the client echoes as {@code params.sessionId}. */
    public final String id;
    /** Current lifecycle state (mutable; transitions on world.join/leave/close). */
    public String state;
    /** Granted capability keys for this session. */
    public final Set<String> granted;
    /** Free-form per-session attributes handlers may use. */
    public final Map<String, Object> attrs;
    /** LIFO registry of cleanup runnables released on close. */
    public final ResourceRegistry resources;

    public McTestSession(String id, Set<String> granted) {
        this.id = id;
        this.state = STATE_READY;
        this.granted = granted != null ? new HashSet<>(granted) : new HashSet<>();
        this.attrs = new LinkedHashMap<>();
        this.resources = new ResourceRegistry();
    }

    /** @return true if {@code key} was granted in this session. */
    public boolean grants(String key) {
        return granted.contains(key);
    }

    public boolean isClosed() {
        return STATE_CLOSED.equals(state);
    }

    /**
     * LIFO collection of cleanup callbacks. Handlers register a {@link Runnable} per resource they
     * acquire (an applied fixture, a spawned fake player); {@link #releaseAll()} runs them in reverse
     * order of registration so teardown mirrors setup.
     */
    public static final class ResourceRegistry {
        private final Deque<Runnable> cleanups = new ArrayDeque<>();

        /** Registers a cleanup to run (once) on session close. */
        public synchronized void register(Runnable cleanup) {
            if (cleanup != null) {
                cleanups.push(cleanup);
            }
        }

        /** @return a live, unmodifiable snapshot of registered cleanups (diagnostics/tests). */
        public synchronized java.util.List<Runnable> snapshot() {
            return Collections.unmodifiableList(new java.util.ArrayList<>(cleanups));
        }

        public synchronized int size() {
            return cleanups.size();
        }

        /** Runs every registered cleanup in LIFO order, swallowing individual failures. */
        public synchronized void releaseAll() {
            while (!cleanups.isEmpty()) {
                Runnable r = cleanups.pop();
                try {
                    r.run();
                } catch (RuntimeException ignored) {
                    // Best-effort teardown: one failing cleanup must not block the rest.
                }
            }
        }
    }
}
