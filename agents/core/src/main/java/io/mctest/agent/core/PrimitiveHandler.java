package io.mctest.agent.core;

import com.google.gson.JsonObject;

/**
 * A single MCTP primitive handler. Each registered method maps to one handler that performs exactly
 * one observable action / one snapshot (PROTOCOL.md §7) and returns the {@code result} object. Throw
 * {@link McTestException} to produce a JSON-RPC error envelope.
 *
 * <p>Handlers are dumb: no selectors-resolution policy, retries, waits, or assertions beyond a single
 * bounded {@code timeoutMs}. All intelligence lives in the runner.
 */
@FunctionalInterface
public interface PrimitiveHandler {

    JsonObject handle(McTestSession session, JsonObject params) throws McTestException;
}
