/**
 * A tiny in-repo MCTP **server agent** (the serverPlugin side) for the M3
 * "testing the tester" layer. It advertises `worldTruth, pluginState, fixtures,
 * fakePlayers, chat, testIdTags` (kind `serverPlugin`) and answers the
 * truth/fixture/player methods over real WebSocket frames — so the runner's
 * multi-connection fan-out, co-selection union, and the truth/UI divergence
 * control are exercised with no Minecraft boot (ROADMAP §7.2/§7.3).
 *
 * It is the co-connected peer of `MockAgent` (the headless driver): the driver
 * scripts the GUI/chat half, this agent answers the server-truth half. Routing
 * is proven by which mock receives which call (`calls` log).
 */
import { WebSocketServer, type WebSocket } from "ws";
import type { AddressInfo } from "node:net";

export interface MockServerAgentOptions {
  /** Advertised capability keys (defaults to the serverPlugin set). */
  capabilities?: string[];
  /** Regions to pre-seed into the store (so `regions.exists` is true from the start). */
  seedRegions?: string[];
  /**
   * Mod/plugin ids the (mock) loader reports as present, so the loader-provided
   * `mod.loaded`/`plugin.loaded` built-in query (F5) resolves `true` for them and
   * `false` otherwise — the runtime proof a downloaded mod loaded.
   */
  seedMods?: string[];
  /**
   * Force the truth/UI divergence control: `regions.exists` always returns
   * `false` regardless of the store (chat may say "Region loaded" but real state
   * disagrees). The runner must then go RED on `assertPluginState`.
   */
  forceRegionMissing?: boolean;
  /** Seeded block returned by `truth.getWorldBlock`. */
  block?: { type: string; properties?: Record<string, string>; biome?: string };
}

const DEFAULT_CAPS = ["worldTruth", "pluginState", "fixtures", "fakePlayers", "chat", "testIdTags"];

interface FakePlayerRecord {
  name: string;
  uuid: string;
  handle: string;
}

export class MockServerAgent {
  private wss: WebSocketServer | null = null;
  private url = "";
  private readonly caps: string[];
  private readonly forceMissing: boolean;
  private readonly block: { type: string; properties?: Record<string, string>; biome?: string };

  // SUT-ish state (single session for tests).
  private readonly regions = new Set<string>();
  /** Loader-present mod/plugin ids (the `mod.loaded` built-in resolves against this). */
  private readonly mods = new Set<string>();
  private readonly appliedFixtures: { handle: string; fixture: string; region?: string }[] = [];
  private readonly fakePlayers = new Map<string, FakePlayerRecord>();
  private uuidSeq = 1;

  /** Every method this agent received — proves GUI calls do NOT reach the agent. */
  readonly calls: string[] = [];

  constructor(opts: MockServerAgentOptions = {}) {
    this.caps = opts.capabilities ?? DEFAULT_CAPS;
    this.forceMissing = opts.forceRegionMissing ?? false;
    this.block = opts.block ?? { type: "minecraft:oak_sign", properties: { rotation: "8" }, biome: "minecraft:plains" };
    for (const r of opts.seedRegions ?? []) this.regions.add(r);
    for (const m of opts.seedMods ?? []) this.mods.add(m);
  }

  start(): Promise<{ url: string }> {
    return new Promise((resolve) => {
      const wss = new WebSocketServer({
        host: "127.0.0.1",
        port: 0,
        path: "/mctp",
        handleProtocols: (protocols) => (protocols.has("mctp.v1") ? "mctp.v1" : false),
      });
      this.wss = wss;
      wss.on("connection", (ws) => ws.on("message", (d) => this.onMessage(ws, d.toString())));
      wss.on("listening", () => {
        const addr = wss.address() as AddressInfo;
        this.url = `ws://127.0.0.1:${addr.port}/mctp`;
        resolve({ url: this.url });
      });
    });
  }

  async stop(): Promise<void> {
    const wss = this.wss;
    this.wss = null;
    if (wss) await new Promise<void>((r) => wss.close(() => r()));
  }

  /** Does the agent currently believe the named region exists? (honors divergence). */
  hasRegion(name: string): boolean {
    if (this.forceMissing) return false;
    return this.regions.has(name);
  }

  private uuid(): string {
    return `00000000-0000-0000-0000-${String(this.uuidSeq++).padStart(12, "0")}`;
  }

  private onMessage(ws: WebSocket, raw: string): void {
    let req: { id?: number | string; method?: string; params?: Record<string, unknown> };
    try {
      req = JSON.parse(raw);
    } catch {
      return;
    }
    if (req.id === undefined || req.method === undefined) return;
    this.calls.push(req.method);
    try {
      const result = this.dispatch(req.method, req.params ?? {});
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }));
    } catch (err) {
      const e = err as { code?: number; reason?: string; message?: string; data?: Record<string, unknown> };
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: req.id,
          error: {
            code: e.code ?? -32603,
            message: e.message ?? "error",
            data: { reason: e.reason ?? "internalError", retryable: false, ...(e.data ?? {}) },
          },
        }),
      );
    }
  }

  private err(code: number, reason: string, message: string, data?: Record<string, unknown>): never {
    throw { code, reason, message, data };
  }

  /** Resolve a `regions.exists`-style query to a value (honoring divergence). */
  private queryValue(query: string, args: Record<string, unknown>): unknown {
    switch (query) {
      // Loader-provided built-in (F5): SUT-agnostic mod/plugin presence. The id
      // can come from `args.id` or the `mod.loaded(<id>)` head-arg shorthand.
      case "mod.loaded":
      case "plugin.loaded":
        return this.mods.has(String(args["id"] ?? args["0"] ?? ""));
      case "regions.exists":
        return this.hasRegion(String(args["name"] ?? ""));
      case "regions.count":
        return this.forceMissing ? 0 : this.regions.size;
      case "regions.list":
        return this.forceMissing ? [] : [...this.regions];
      default:
        this.err(-32006, "ASSERT_FAILED", `unknown query '${query}'`);
    }
  }

  /** Evaluate a §10.4 expect predicate against a value (the subset the tests use). */
  private evaluate(expect: Record<string, unknown> | undefined, value: unknown): boolean | null {
    if (!expect) return null;
    if ("equals" in expect) return value === expect["equals"];
    if ("notEquals" in expect) return value !== expect["notEquals"];
    if ("gt" in expect) return Number(value) > Number(expect["gt"]);
    if ("gte" in expect) return Number(value) >= Number(expect["gte"]);
    if ("lt" in expect) return Number(value) < Number(expect["lt"]);
    if ("lte" in expect) return Number(value) <= Number(expect["lte"]);
    if ("contains" in expect) return Array.isArray(value) && value.includes(expect["contains"]);
    if ("exists" in expect) return (value !== undefined && value !== null) === Boolean(expect["exists"]);
    return null;
  }

  private entities(): unknown[] {
    // Each spawned fake player shows up as a player entity (for getEntities).
    return [...this.fakePlayers.values()].map((fp) => ({
      id: `e_${fp.handle}`,
      uuid: fp.uuid,
      type: "minecraft:player",
      name: fp.name,
      position: { x: 0, y: 64, z: 0 },
      tags: [],
    }));
  }

  private dispatch(method: string, params: Record<string, unknown>): unknown {
    switch (method) {
      case "session.create": {
        const required = (params["requiredCapabilities"] as string[] | undefined) ?? [];
        const unmet = required.filter((c) => !this.caps.includes(c));
        if (unmet.length) this.err(-32002, "METHOD_NOT_SUPPORTED", "missing caps", { unmet, offered: this.caps });
        return {
          ok: true,
          sessionId: "s_srv_mock",
          protocolVersion: "1.0",
          agent: { name: "mock-server-agent", version: "0.0.0", kind: "serverPlugin", lang: "ts" },
          target: { minecraft: "1.20.4", loader: "paper" },
          grantedCapabilities: [...this.caps],
          deniedCapabilities: [],
          capabilityDetails: { worldTruth: { version: 1, radiusLimit: 64 }, fakePlayers: { backend: "carpet" } },
        };
      }
      case "session.describe":
        return {
          ok: true,
          protocolVersion: "1.0",
          supportedProtocols: ["1.0"],
          agent: { name: "mock-server-agent", version: "0.0.0", kind: "serverPlugin" },
          capabilities: [...this.caps],
        };
      case "session.ping":
        return { ok: true, nonce: params["nonce"] };
      case "session.close":
        // Release per-session resources (fixtures applied, fake players spawned).
        for (const fx of this.appliedFixtures.splice(0)) {
          if (fx.region) this.regions.delete(fx.region);
        }
        this.fakePlayers.clear();
        return { ok: true };
      case "world.join":
        // serverPlugin no-op join → Connected; player fields may be null.
        return { ok: true, playerName: null, serverBrand: "mock-paper" };
      case "world.leave":
        return { ok: true };

      case "truth.getWorldBlock":
        return { ok: true, block: this.block };

      case "truth.getEntities": {
        const ents = this.entities();
        const typeFilter = params["type"] as string | undefined;
        const filtered = typeFilter ? ents.filter((e) => String((e as { type: string }).type).includes(typeFilter.replace(/^minecraft:/, ""))) : ents;
        return { ok: true, count: filtered.length, entities: filtered };
      }

      case "truth.assertPluginState": {
        const query = String(params["query"] ?? "");
        const args = (params["args"] as Record<string, unknown> | undefined) ?? {};
        const expect = params["expect"] as Record<string, unknown> | undefined;
        const value = this.queryValue(query, args);
        const matched = this.evaluate(expect, value);
        return { ok: true, query, value, matched, valueJson: JSON.stringify(value) };
      }

      case "fixture.set": {
        const fixture = String(params["fixture"] ?? "");
        const args = (params["args"] as Record<string, unknown> | undefined) ?? {};
        const handle = `fx_${this.appliedFixtures.length + 1}`;
        if (fixture === "regions.createRegion") {
          const name = String(args["name"] ?? "");
          if (!name) this.err(-32602, "invalidParams", "regions.createRegion needs args.name");
          this.regions.add(name);
          this.appliedFixtures.push({ handle, fixture, region: name });
          return { ok: true, fixture, applied: true, handle, result: { regionId: name } };
        }
        if (fixture === "regions.deleteRegion") {
          const name = String(args["name"] ?? "");
          this.regions.delete(name);
          this.appliedFixtures.push({ handle, fixture });
          return { ok: true, fixture, applied: true, handle };
        }
        this.err(-32005, "FIXTURE_FAILED", `unknown fixture '${fixture}'`);
      }

      case "fixture.reset": {
        // No-arg reset reverts all session fixtures (region creations).
        let restored = 0;
        for (const fx of this.appliedFixtures.splice(0)) {
          if (fx.region) {
            this.regions.delete(fx.region);
            restored++;
          }
        }
        return { ok: true, restored, tookMs: 0 };
      }

      case "player.spawnFake": {
        const name = String(params["name"] ?? "");
        if (!name) this.err(-32602, "invalidParams", "player.spawnFake needs name");
        const handle = `fp_${name}`;
        const record: FakePlayerRecord = { name, uuid: this.uuid(), handle };
        this.fakePlayers.set(handle, record);
        return { ok: true, name, uuid: record.uuid, handle };
      }

      case "player.despawnFake": {
        const handle = (params["handle"] as string | undefined) ?? `fp_${String(params["name"] ?? "")}`;
        if (!this.fakePlayers.has(handle)) this.err(-32602, "invalidParams", `unknown fake player '${handle}'`);
        this.fakePlayers.delete(handle);
        return { ok: true, despawned: handle };
      }

      default:
        this.err(-32002, "METHOD_NOT_SUPPORTED", `mock server agent has no ${method}`);
    }
  }
}
