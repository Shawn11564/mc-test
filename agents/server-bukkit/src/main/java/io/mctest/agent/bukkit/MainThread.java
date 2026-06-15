package io.mctest.agent.bukkit;

import io.mctest.agent.core.McTestException;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import org.bukkit.Bukkit;
import org.bukkit.plugin.Plugin;

/**
 * Bounces a unit of work onto the Bukkit server (main) thread and waits for the result. The MCTP
 * dispatch loop runs on a Java-WebSocket worker thread, but all Bukkit world/entity/scheduler access
 * MUST happen on the server thread — so every handler that touches the game routes its body through
 * {@link #call}.
 *
 * <p>Implemented with {@code Bukkit.getScheduler().callSyncMethod(...)} (the canonical Bukkit
 * sync-call primitive). A bounded {@code timeoutMs} maps an overrun onto {@code -32003 TIMEOUT};
 * a failure inside the callable surfaces its own {@link McTestException} (or {@code -32603}).
 */
public final class MainThread {

    private MainThread() {
    }

    /**
     * Runs {@code body} on the server thread and returns its value, blocking up to {@code timeoutMs}.
     * If already on the main thread, runs inline to avoid a self-deadlock.
     *
     * @throws McTestException {@code TIMEOUT} on overrun, the callable's own {@link McTestException},
     *                         or {@code INTERNAL_ERROR} for any other failure.
     */
    public static <T> T call(Plugin plugin, Callable<T> body, long timeoutMs) throws McTestException {
        if (Bukkit.isPrimaryThread()) {
            return callInline(body);
        }

        // During plugin disable / server shutdown the scheduler rejects new sync tasks
        // (IllegalPluginAccessException) — but socket-close session cleanups (fixture revert,
        // fake-player despawn) still need to run. Degrade to a best-effort inline call so they
        // are not silently swallowed.
        if (!plugin.isEnabled()) {
            return callInline(body);
        }

        Future<T> future;
        try {
            future = Bukkit.getScheduler().callSyncMethod(plugin, body);
        } catch (RuntimeException e) {
            // Plugin became disabled between the isEnabled() check and the scheduler call.
            return callInline(body);
        }
        try {
            return future.get(Math.max(1L, timeoutMs), TimeUnit.MILLISECONDS);
        } catch (TimeoutException e) {
            future.cancel(true);
            throw McTestException.timeout("Main-thread call exceeded " + timeoutMs + "ms");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw McTestException.internal("Interrupted waiting for main thread");
        } catch (ExecutionException e) {
            Throwable cause = e.getCause();
            if (cause instanceof McTestException) {
                throw (McTestException) cause;
            }
            throw McTestException.internal("Main-thread call failed: " + describe(cause));
        }
    }

    /** Runs the callable on the current thread, mapping its failure to the canonical error codes. */
    private static <T> T callInline(Callable<T> body) throws McTestException {
        try {
            return body.call();
        } catch (McTestException e) {
            throw e;
        } catch (Exception e) {
            throw McTestException.internal("Main-thread call failed: " + describe(e));
        }
    }

    private static String describe(Throwable t) {
        if (t == null) {
            return "unknown";
        }
        String msg = t.getMessage();
        return msg != null ? t.getClass().getSimpleName() + ": " + msg : t.getClass().getSimpleName();
    }
}
