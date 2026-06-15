package io.mctest.agent.core;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import java.util.Collection;

/**
 * A typed MCTP failure carrying a JSON-RPC error {@code code}, a stable {@code reason} token, and
 * an {@code error.data} object (PROTOCOL.md §9). Handlers throw this; {@link MctpServer} serializes
 * it into a JSON-RPC error envelope. Each factory sets {@code data.reason} and {@code data.retryable}
 * consistently with {@link Errors}.
 */
public class McTestException extends Exception {

    /** JSON-RPC numeric error code (e.g. {@link Errors#FIXTURE_FAILED}). */
    public final int code;
    /** Stable machine token mirroring the code (e.g. {@code "FIXTURE_FAILED"}). */
    public final String reason;
    /** The {@code error.data} object; always carries {@code reason} and {@code retryable}. */
    public final JsonObject data;

    public McTestException(int code, String reason, String message, JsonObject data) {
        super(message);
        this.code = code;
        this.reason = reason;
        this.data = data != null ? data : new JsonObject();
        // Guarantee the canonical data fields are present and correct.
        this.data.addProperty("reason", reason);
        if (!this.data.has("retryable")) {
            this.data.addProperty("retryable", Errors.retryableFor(code));
        }
    }

    /** Convenience: build with the message also used as the human-readable text. */
    public McTestException(int code, String reason, String message) {
        this(code, reason, message, new JsonObject());
    }

    // --- Static factories (one per canonical condition; see plan "Public API") ---

    /**
     * Negotiation refusal: required capabilities missing (PROTOCOL.md §5.3). Carries
     * {@code data.unmet[]} and {@code data.offered[]}; no session is created. → {@code -32002}.
     */
    public static McTestException methodNotSupported(Collection<String> unmet, Collection<String> offered) {
        JsonObject data = new JsonObject();
        data.add("unmet", toArray(unmet));
        data.add("offered", toArray(offered));
        return new McTestException(
                Errors.METHOD_NOT_SUPPORTED,
                Errors.REASON_METHOD_NOT_SUPPORTED,
                "Required capabilities not available",
                data);
    }

    /** A method/feature this agent build does not implement (or its capability was not granted). */
    public static McTestException methodNotSupported(String message) {
        return new McTestException(Errors.METHOD_NOT_SUPPORTED, Errors.REASON_METHOD_NOT_SUPPORTED, message);
    }

    /**
     * A target descriptor constraint ({@code loader} / {@code mcVersionRange}) could not be
     * satisfied at {@code session.create} (PROTOCOL.md §5.1 step 2 / §5.3). Carries the failed
     * descriptor key in both {@code data.unmet[]} and {@code data.constraint}; no session is created.
     * → {@code -32002}.
     */
    public static McTestException constraintUnsatisfied(String constraint, String message) {
        JsonObject data = new JsonObject();
        JsonArray unmet = new JsonArray();
        unmet.add(constraint);
        data.add("unmet", unmet);
        data.addProperty("constraint", constraint);
        return new McTestException(
                Errors.METHOD_NOT_SUPPORTED,
                Errors.REASON_METHOD_NOT_SUPPORTED,
                message,
                data);
    }

    /** Params fail MCTP schema/semantics, or a missing/unknown/closed sessionId. → {@code -32602}. */
    public static McTestException invalidParams(String message) {
        return new McTestException(Errors.INVALID_PARAMS, Errors.REASON_INVALID_PARAMS, message);
    }

    /** World/chunk/block not loaded or out of range. Retryable. → {@code -32004}. */
    public static McTestException worldNotReady(String message) {
        return new McTestException(Errors.WORLD_NOT_READY, Errors.REASON_WORLD_NOT_READY, message);
    }

    /** Unknown fixture name or a recipe that failed to apply/reset. → {@code -32005}. */
    public static McTestException fixtureFailed(String message) {
        return new McTestException(Errors.FIXTURE_FAILED, Errors.REASON_FIXTURE_FAILED, message);
    }

    /** A plugin-state probe could not be evaluated (unknown query / eval failure). → {@code -32006}. */
    public static McTestException assertFailed(String message) {
        return new McTestException(Errors.ASSERT_FAILED, Errors.REASON_ASSERT_FAILED, message);
    }

    /** A single primitive overran its {@code timeoutMs}. Retryable. → {@code -32003}. */
    public static McTestException timeout(String message) {
        return new McTestException(Errors.TIMEOUT, Errors.REASON_TIMEOUT, message);
    }

    /** Selector matched zero elements. Retryable. → {@code -32000}. */
    public static McTestException elementNotFound(JsonObject selector) {
        JsonObject data = new JsonObject();
        if (selector != null) {
            JsonObject details = new JsonObject();
            details.add("selector", selector);
            data.add("details", details);
        }
        return new McTestException(
                Errors.ELEMENT_NOT_FOUND,
                Errors.REASON_ELEMENT_NOT_FOUND,
                "No element matched selector",
                data);
    }

    /** Selector matched &gt;1 element without {@code nth}/{@code index}. → {@code -32001}. */
    public static McTestException ambiguous(JsonArray matches) {
        JsonObject data = new JsonObject();
        if (matches != null) {
            JsonObject details = new JsonObject();
            details.add("matches", matches);
            data.add("details", details);
        }
        return new McTestException(
                Errors.AMBIGUOUS_SELECTOR,
                Errors.REASON_AMBIGUOUS_SELECTOR,
                "Selector matched more than one element",
                data);
    }

    /** Requested protocolVersion major is not supported (handshake). → {@code -32099}. */
    public static McTestException protocolUnsupported(String message) {
        return new McTestException(
                Errors.PROTOCOL_VERSION_UNSUPPORTED,
                Errors.REASON_PROTOCOL_VERSION_UNSUPPORTED,
                message);
    }

    /** Unexpected agent-side failure not otherwise classified. → {@code -32603}. */
    public static McTestException internal(String message) {
        return new McTestException(Errors.INTERNAL_ERROR, Errors.REASON_INTERNAL_ERROR, message);
    }

    private static JsonArray toArray(Collection<String> values) {
        JsonArray arr = new JsonArray();
        if (values != null) {
            for (String v : values) {
                arr.add(v);
            }
        }
        return arr;
    }
}
