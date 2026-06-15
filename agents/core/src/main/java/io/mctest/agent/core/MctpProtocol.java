package io.mctest.agent.core;

/**
 * Protocol-version constants and the major-compatibility check (PROTOCOL.md §10). The negotiated
 * value is a {@code "<major>.<minor>"} string starting at {@code "1.0"}; the WebSocket sub-protocol
 * token tracks major only ({@code mctp.v1}).
 */
public final class MctpProtocol {

    /** The protocol version this core speaks. */
    public static final String VERSION = "1.0";

    /** Versions advertised in {@code session.describe.supportedProtocols}. */
    public static final String[] SUPPORTED_PROTOCOLS = {"1.0"};

    /** The major this core implements (matches the {@code mctp.v1} sub-protocol token). */
    public static final int MAJOR = 1;

    /** The WebSocket sub-protocol token (PROTOCOL.md §2.1). */
    public static final String SUBPROTOCOL = "mctp.v1";

    /** The required endpoint path (PROTOCOL.md §2.1). */
    public static final String PATH = "/mctp";

    private MctpProtocol() {
    }

    /**
     * Whether the requested {@code "<major>.<minor>"} version shares this core's major. Within a major,
     * changes are additive/backward-compatible (PROTOCOL.md §10), so any minor is accepted.
     */
    public static boolean isMajorSupported(String protocolVersion) {
        if (protocolVersion == null) {
            return false;
        }
        int dot = protocolVersion.indexOf('.');
        String majorStr = dot >= 0 ? protocolVersion.substring(0, dot) : protocolVersion;
        try {
            return Integer.parseInt(majorStr.trim()) == MAJOR;
        } catch (NumberFormatException e) {
            return false;
        }
    }
}
