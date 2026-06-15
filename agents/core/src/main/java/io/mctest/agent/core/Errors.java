package io.mctest.agent.core;

/**
 * Canonical MCTP error codes and stable {@code reason} tokens (PROTOCOL.md §9).
 *
 * <p>Clients branch on {@code error.data.reason}, never on {@code message}. The numeric code and
 * the reason token are paired here so the dispatch layer can emit both consistently. All spellings
 * are copied verbatim from PROTOCOL.md §9.2/§9.3 and the §13 index — do not introduce synonyms.
 */
public final class Errors {

    private Errors() {
    }

    // --- MCTP-specific codes (implementation-defined server range -32000…-32099) ---
    public static final int ELEMENT_NOT_FOUND = -32000;
    public static final int AMBIGUOUS_SELECTOR = -32001;
    public static final int METHOD_NOT_SUPPORTED = -32002;
    public static final int TIMEOUT = -32003;
    public static final int WORLD_NOT_READY = -32004;
    public static final int FIXTURE_FAILED = -32005;
    public static final int ASSERT_FAILED = -32006;
    public static final int PROTOCOL_VERSION_UNSUPPORTED = -32099;

    // --- Standard JSON-RPC 2.0 codes ---
    public static final int PARSE_ERROR = -32700;
    public static final int INVALID_REQUEST = -32600;
    public static final int METHOD_NOT_FOUND = -32601;
    public static final int INVALID_PARAMS = -32602;
    public static final int INTERNAL_ERROR = -32603;

    // --- Stable reason tokens (mirror the numeric code; see PROTOCOL.md §9) ---
    public static final String REASON_ELEMENT_NOT_FOUND = "ELEMENT_NOT_FOUND";
    public static final String REASON_AMBIGUOUS_SELECTOR = "AMBIGUOUS_SELECTOR";
    public static final String REASON_METHOD_NOT_SUPPORTED = "METHOD_NOT_SUPPORTED";
    public static final String REASON_TIMEOUT = "TIMEOUT";
    public static final String REASON_WORLD_NOT_READY = "WORLD_NOT_READY";
    public static final String REASON_FIXTURE_FAILED = "FIXTURE_FAILED";
    public static final String REASON_ASSERT_FAILED = "ASSERT_FAILED";
    public static final String REASON_PROTOCOL_VERSION_UNSUPPORTED = "PROTOCOL_VERSION_UNSUPPORTED";

    public static final String REASON_PARSE_ERROR = "parseError";
    public static final String REASON_INVALID_REQUEST = "invalidRequest";
    public static final String REASON_METHOD_NOT_FOUND = "methodNotFound";
    public static final String REASON_INVALID_PARAMS = "invalidParams";
    public static final String REASON_INTERNAL_ERROR = "internalError";

    /** Maps a numeric code to its canonical reason token (best effort; null for unknown codes). */
    public static String reasonFor(int code) {
        switch (code) {
            case ELEMENT_NOT_FOUND:
                return REASON_ELEMENT_NOT_FOUND;
            case AMBIGUOUS_SELECTOR:
                return REASON_AMBIGUOUS_SELECTOR;
            case METHOD_NOT_SUPPORTED:
                return REASON_METHOD_NOT_SUPPORTED;
            case TIMEOUT:
                return REASON_TIMEOUT;
            case WORLD_NOT_READY:
                return REASON_WORLD_NOT_READY;
            case FIXTURE_FAILED:
                return REASON_FIXTURE_FAILED;
            case ASSERT_FAILED:
                return REASON_ASSERT_FAILED;
            case PROTOCOL_VERSION_UNSUPPORTED:
                return REASON_PROTOCOL_VERSION_UNSUPPORTED;
            case PARSE_ERROR:
                return REASON_PARSE_ERROR;
            case INVALID_REQUEST:
                return REASON_INVALID_REQUEST;
            case METHOD_NOT_FOUND:
                return REASON_METHOD_NOT_FOUND;
            case INVALID_PARAMS:
                return REASON_INVALID_PARAMS;
            case INTERNAL_ERROR:
                return REASON_INTERNAL_ERROR;
            default:
                return null;
        }
    }

    /** Whether the given code is retryable per PROTOCOL.md §9.2 (transient conditions). */
    public static boolean retryableFor(int code) {
        switch (code) {
            case ELEMENT_NOT_FOUND:
            case TIMEOUT:
            case WORLD_NOT_READY:
                return true;
            default:
                return false;
        }
    }
}
