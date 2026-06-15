/**
 * Frozen transport & handshake constants (PROTOCOL.md §2, §4, §10).
 *
 * The transport is NOT swappable — it *is* the contract: JSON-RPC 2.0 over a
 * single WebSocket, runner = client, agent/driver = server.
 */

/** The current protocol version the runner speaks; negotiated at `session.create`. */
export const PROTOCOL_VERSION = "1.0" as const;

/** Protocol versions this contract package knows about. */
export const SUPPORTED_PROTOCOLS = ["1.0"] as const;

/** WebSocket sub-protocol token (tracks the protocol *major* only). */
export const MCTP_SUBPROTOCOL = "mctp.v1" as const;

/** Default WebSocket endpoint path an agent MUST serve. */
export const MCTP_DEFAULT_PATH = "/mctp" as const;

/** Default maximum single WebSocket frame size (8 MiB). */
export const MCTP_DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;

/** Human-readable protocol identifier, e.g. `mctp/1.0`. */
export const MCTP_PROTOCOL_ID = `mctp/${PROTOCOL_VERSION}` as const;
