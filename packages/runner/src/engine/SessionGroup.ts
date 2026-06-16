/**
 * The multi-connection session (ROADMAP §4.2/§4.5). ONE logical session fans
 * GUI/chat steps to the headless **driver** connection and truth/fixture/player
 * steps to the **server-agent** connection — the test author writes no
 * connection plumbing. Each connection is its own `MctpClient` + negotiated
 * `Session` (its own `sessionId`); routing picks the connection that advertises
 * the step's capability. Capability misses still produce honest skips upstream
 * (the Runner consults `unionAdvertised()` before any step runs).
 *
 * Protocol-first: every connection negotiates `session.create` exactly as a
 * single-connection M2 session does; there is no bypass path for "agent vs
 * driver" — same `MctpClient`, same envelopes.
 */
import { PROTOCOL_VERSION, matchCapabilities, type Capabilities, type CapabilityKey } from "@mc-test/protocol";
import { MctpClient, MctpRpcError } from "../drivers/MctpClient.js";
import { Session } from "./Session.js";
import { advertisedKeys } from "./CapabilityMatch.js";
import type { StepCapReq } from "./StepExecutor.js";

/** One connection to open and negotiate within the group. */
export interface ConnDef {
  url: string;
  /** Capability keys this connection MUST be granted (its session.create `required`). */
  required: string[];
  /** Capability keys offered as optional (never a cause to refuse). */
  optional?: string[];
  /** What the connection advertises (drives routing + the union). */
  advertised: Capabilities;
  role: "driver" | "agent";
  /** Negotiation constraints (mc/loader), forwarded to `session.create`. */
  constraints?: { mcVersionRange?: string; loader?: string };
}

/** A live, negotiated connection within the group. */
interface Conn {
  def: ConnDef;
  client: MctpClient;
  session: Session;
}

/**
 * Holds the primary (driver) session plus zero-or-more agent sessions, each on
 * its own client. The Runner builds one of these per test, routes each step's
 * MCTP calls through `route(cap)`, and tears the whole group down at the end.
 */
export class SessionGroup {
  private readonly conns: Conn[] = [];
  /** A connection that refused negotiation (its caps are absent from the union). */
  private refused: { def: ConnDef; unmet: string[] }[] = [];

  /**
   * Open + negotiate each connection in order. An **agent** that fails to connect
   * for ANY reason — a `-32002` capability refusal OR a transport failure
   * (connection refused / timeout while its MCTP port is not yet bound) — simply
   * drops out of the union; its capability-gated steps then honestly skip
   * (`unmet:[…]`), never failing the whole test. A refusing/unreachable
   * **driver** is re-thrown so the Runner maps it to a test-level skip (M2).
   */
  async connect(connections: ConnDef[]): Promise<void> {
    for (const def of connections) {
      const client = new MctpClient();
      const session = new Session(client);
      try {
        await client.connect(def.url);
        await session.create({
          protocolVersion: PROTOCOL_VERSION,
          requiredCapabilities: def.required,
          ...(def.optional ? { optionalCapabilities: def.optional } : {}),
          ...(def.constraints ? { constraints: def.constraints } : {}),
        });
        this.conns.push({ def, client, session });
      } catch (err) {
        await client.close().catch(() => {});
        if (def.role === "agent") {
          // Any agent connect/negotiation failure → drop out of the union. Use the
          // negotiation `unmet[]` when present, else the agent's required caps (a
          // transport failure means none of them are reachable) so capability-gated
          // steps skip with the right `unmet`.
          const unmet = err instanceof MctpRpcError ? err.unmet : def.required;
          this.refused.push({ def, unmet });
          continue;
        }
        // A refusing/unreachable driver is the caller's to handle (→ test skip / fail).
        throw err;
      }
    }
  }

  /** The primary (driver) session — the routing target for `cap === null`. */
  get primary(): Session | undefined {
    return this.conns.find((c) => c.def.role === "driver")?.session;
  }

  /** Did any connection successfully negotiate? */
  get connected(): boolean {
    return this.conns.length > 0;
  }

  /**
   * The merge of every successfully-connected connection's advertised caps. The
   * Runner uses this (NOT just the driver) for per-step skip decisions, so an
   * `assertPluginState` step RUNS when an agent is co-connected and still
   * honestly SKIPS `unmet:["pluginState"]` when no agent is.
   */
  unionAdvertised(): Capabilities {
    const union: Capabilities = {};
    for (const c of this.conns) {
      if (c.def.role === "agent") {
        // Reflect the agent's ACTUAL granted caps (its session.create response), NOT a
        // runner-side assumption — so an agent that honestly advertises a subset (e.g.
        // no `fakePlayers` without a Carpet backend) is represented truthfully and only
        // its genuinely-present caps satisfy steps. Capability discovery, not hardcoding.
        for (const key of c.session.granted) {
          union[key as CapabilityKey] = true;
        }
        continue;
      }
      // The driver's advertised set is authoritative for routing GUI/chat verbs; carry
      // its target descriptors (loader/mcVersionRange) for negotiation parity.
      for (const key of advertisedKeys(c.def.advertised)) {
        union[key] = true;
      }
      if (c.def.advertised.loader !== undefined) union.loader = c.def.advertised.loader;
      if (c.def.advertised.mcVersionRange !== undefined) union.mcVersionRange = c.def.advertised.mcVersionRange;
    }
    return union;
  }

  /**
   * Route a capability requirement to the connection that advertises it. `null`
   * (capability-free verbs like `join`/`leave`) → the primary/driver session. A
   * single key (`worldTruth`, `pluginState`, `fixtures`, `fakePlayers` → the
   * server-agent session; `chat`, `screenshot`, … → the driver) routes to the
   * first connection advertising it. An **anyOf group** (e.g. the screen verbs'
   * `["containerGui","clientScreens"]`) routes to the first connection advertising
   * ANY member — and because connections are pushed driver-first, a GUI verb
   * lands on the driver. Returns `undefined` only if nothing routes (the step was
   * already skipped upstream, so this is defensive).
   */
  route(cap: StepCapReq): Session | undefined {
    if (cap === null) return this.primary;
    const keys = Array.isArray(cap) ? cap : [cap as CapabilityKey];
    // Driver-first ordering (conns pushed driver-first): first conn advertising ANY key.
    const owner = this.conns.find((c) => keys.some((k) => matchCapabilities({ [k]: true }, c.def.advertised).ok));
    return owner?.session ?? this.primary;
  }

  /** Close every session and connection (best-effort). */
  async closeAll(reason?: string): Promise<void> {
    for (const c of this.conns) {
      await c.session.close(reason);
      await c.client.close().catch(() => {});
    }
    this.conns.length = 0;
  }
}
