/**
 * A negotiated MCTP session over one connection. Owns the `sessionId` and
 * injects it into every stateful call. In M2 a session wraps a single
 * connection; the multi-connection (driver + server agent) fan-out is M3.
 */
import { MctpClient } from "../drivers/MctpClient.js";

export interface SessionCreateParams {
  protocolVersion: string;
  requiredCapabilities: string[];
  optionalCapabilities?: string[];
  constraints?: { mcVersionRange?: string; loader?: string };
}

export interface SessionCreateResult {
  ok?: boolean;
  sessionId: string;
  protocolVersion: string;
  grantedCapabilities?: string[];
  deniedCapabilities?: string[];
  [k: string]: unknown;
}

/** A live MCTP session bound to one client connection. */
export class Session {
  sessionId = "";
  granted: string[] = [];

  constructor(private readonly client: MctpClient) {}

  /** Negotiate the session; throws `MctpRpcError` on refusal (the runner maps it to a skip). */
  async create(params: SessionCreateParams): Promise<SessionCreateResult> {
    const result = await this.client.call<SessionCreateResult>("session.create", {
      protocolVersion: params.protocolVersion,
      client: { name: "mc-test-runner", version: "0.1.0", lang: "ts" },
      requiredCapabilities: params.requiredCapabilities,
      ...(params.optionalCapabilities ? { optionalCapabilities: params.optionalCapabilities } : {}),
      ...(params.constraints ? { constraints: params.constraints } : {}),
    });
    this.sessionId = result.sessionId;
    this.granted = result.grantedCapabilities ?? [];
    return result;
  }

  /** Issue a stateful method, injecting `sessionId`. */
  call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.client.call<T>(method, { sessionId: this.sessionId, ...params });
  }

  /** Best-effort graceful close. */
  async close(reason?: string): Promise<void> {
    if (!this.sessionId) return;
    try {
      await this.call("session.close", reason ? { reason } : {});
    } catch {
      /* teardown is best-effort */
    }
  }
}
