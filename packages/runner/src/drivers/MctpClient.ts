/**
 * The MCTP transport: a JSON-RPC 2.0 client over a single WebSocket. The runner
 * uses exactly this to talk to ANY driver/agent — the headless driver and a
 * future JVM agent are indistinguishable here (protocol-first; no bypass).
 */
import WebSocket from "ws";

/** A typed MCTP error surfaced from an error response. */
export class MctpRpcError extends Error {
  constructor(
    readonly code: number,
    readonly reason: string,
    message: string,
    readonly data?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "MctpRpcError";
  }

  /** `unmet[]` from a negotiation refusal (`-32002`), if present. */
  get unmet(): string[] {
    const u = this.data?.["unmet"];
    return Array.isArray(u) ? (u as string[]) : [];
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

/** A JSON-RPC 2.0 client over one WebSocket connection. */
export class MctpClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  /** Open the connection (negotiating the `mctp.v1` sub-protocol). */
  connect(url: string, timeoutMs = 10000): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, ["mctp.v1"]);
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error(`MCTP connect timeout: ${url}`)), timeoutMs);
      ws.on("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      ws.on("message", (data) => this.onMessage(data.toString()));
      ws.on("close", () => this.failAll(new Error("MCTP connection closed")));
    });
  }

  private onMessage(raw: string): void {
    let msg: { id?: number; result?: unknown; error?: { code: number; message?: string; data?: Record<string, unknown> } };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.id === undefined) return; // notification
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    if (msg.error) {
      const reason = (msg.error.data?.["reason"] as string | undefined) ?? "error";
      pending.reject(new MctpRpcError(msg.error.code, reason, msg.error.message ?? "MCTP error", msg.error.data));
    } else {
      pending.resolve(msg.result);
    }
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  /** Issue a request and await its result (rejects with `MctpRpcError` on an error response). */
  call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("MCTP client not connected"));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  /** Close the connection. */
  async close(): Promise<void> {
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    await new Promise<void>((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) return resolve();
      ws.once("close", () => resolve());
      try {
        ws.close();
      } catch {
        resolve();
      }
    });
  }
}
