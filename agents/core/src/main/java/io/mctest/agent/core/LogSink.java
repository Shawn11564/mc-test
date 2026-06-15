package io.mctest.agent.core;

/**
 * Minimal logging seam so the core stays loader-neutral. The Bukkit shim backs this with
 * {@code JavaPlugin#getLogger()}; tests use a no-op or capturing sink.
 */
public interface LogSink {

    /** @param level a log level token (e.g. {@code "INFO"}, {@code "WARN"}, {@code "ERROR"}). */
    void log(String level, String message);
}
