/**
 * A tiny in-repo MCTP agent (WebSocket server) that scripts the regions flow.
 * It lets us unit-test the WHOLE engine — capability negotiation, step→MCTP
 * mapping, SelectorWaits retry/timeout, honest skips, JUnit output — with no
 * Minecraft boot (ROADMAP §7.2). Configurable for negative controls.
 */
import { WebSocketServer, type WebSocket } from "ws";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";

export interface MockAgentOptions {
  /** Advertised capability keys (defaults mirror the headless driver). */
  capabilities?: string[];
  /** The root-menu button label (set to "Zones" for the mutation negative control). */
  regionsButtonLabel?: string;
  /** The list entries (each clickable → "Region loaded: <entry>"). Default: the seeded set. */
  listEntries?: string[];
  /** How many entry-click attempts return ELEMENT_NOT_FOUND before the list "populates"
   *  — exercises runner-side SelectorWaits retries. */
  listAppearAfter?: number;
  /**
   * Seed the toy world model the `world.*` interaction verbs act on, as
   * `"x,y,z" → "minecraft:<id>"`. Lets a test assert the CONSEQUENCE of a
   * sneak-click (a sign landing on the clicked face) without a Minecraft boot.
   */
  blocks?: Record<string, string>;
  /** Items the mock player's inventory holds, e.g. `["minecraft:oak_sign"]`. */
  inventory?: string[];
  /**
   * Blockstate properties per position (`"x,y,z"` -> `{ facing: "east" }`), so a test can assert
   * `expectProperties` without a Minecraft boot.
   */
  blockProperties?: Record<string, Record<string, string>>;
  /** Block-entity documents per position (`"x,y,z"` -> the `nbt` object `truth.getWorldBlock` returns). */
  blockEntities?: Record<string, Record<string, unknown>>;
  /** Container contents per position (`"x,y,z"` -> slot index -> item). */
  containers?: Record<string, Record<string, MockItem>>;
  /** Seed plugin-state query values (`"regions.exists"` -> value) for assert/waitForPluginState. */
  pluginState?: Record<string, unknown>;
}

/** One item in the mock's toy container model (mirrors the wire `ItemStack`). */
export interface MockItem {
  type: string;
  count?: number;
  displayName?: string;
  components?: Record<string, unknown>;
}

const DEFAULT_CAPS = ["chat", "command", "containerGui", "typeText", "pressKey"];

/** Outward normal of each block face — the mock's placement geometry. */
const FACE_VECTORS: Record<string, { x: number; y: number; z: number }> = {
  up: { x: 0, y: 1, z: 0 },
  down: { x: 0, y: -1, z: 0 },
  north: { x: 0, y: 0, z: -1 },
  south: { x: 0, y: 0, z: 1 },
  west: { x: -1, y: 0, z: 0 },
  east: { x: 1, y: 0, z: 0 },
};

const posKey = (p: { x: number; y: number; z: number }): string => `${p.x},${p.y},${p.z}`;

/** Canonical JSON (sorted keys) — the mock hashes exactly as a real agent does. */
function canonical(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** A stable digest over type + components — item identity, exactly like the JVM agent's. */
function itemHash(type: string, components: Record<string, unknown>): string {
  return `sha256:${createHash("sha256")
    .update(canonical({ type, components }))
    .digest("hex")}`;
}

/** Render a mock item in the wire `ItemStack` shape. */
function describeMockItem(item: MockItem, slot: number): Record<string, unknown> {
  const components = item.components ?? {};
  return {
    type: item.type,
    count: item.count ?? 1,
    slot,
    ...(item.displayName ? { displayName: item.displayName } : {}),
    components,
    componentsHash: itemHash(item.type, components),
  };
}
/** Regions the enriched list shows by default (mirrors the plugin's seeded set). */
const DEFAULT_ENTRIES = ["TestRegion", "Spawn", "Market"];
/** The deterministic region the "Create" button adds (mirrors the plugin). */
const CREATE_REGION = "Sanctuary";

function labelEq(a: string | undefined, b: string | undefined): boolean {
  return (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();
}

export class MockAgent {
  private wss: WebSocketServer | null = null;
  private url = "";
  private readonly caps: string[];
  private readonly regionsLabel: string;
  private readonly entries: string[];
  private listReveals: number;

  // per-connection-ish state (single session for tests)
  private screen: "none" | "root" | "list" = "none";
  private chat: string[] = [];
  private active: string | null = null;

  // Toy world/player model for the `world.*` interaction verbs.
  private readonly blocks: Map<string, string>;
  private readonly blockProperties: Map<string, Record<string, string>>;
  private readonly blockEntities: Map<string, Record<string, unknown>>;
  private readonly containers: Map<string, Record<string, MockItem>>;
  private readonly pluginState: Map<string, unknown>;
  private readonly inventory: string[];
  private held: string | null = null;
  private heldSlot = 0;
  private yaw = 0;
  private pitch = 0;
  private controls: string[] = [];

  constructor(opts: MockAgentOptions = {}) {
    this.caps = opts.capabilities ?? DEFAULT_CAPS;
    this.regionsLabel = opts.regionsButtonLabel ?? "Regions";
    this.entries = opts.listEntries ?? [...DEFAULT_ENTRIES];
    this.listReveals = opts.listAppearAfter ?? 0;
    this.blocks = new Map(Object.entries(opts.blocks ?? {}));
    this.blockProperties = new Map(Object.entries(opts.blockProperties ?? {}));
    this.blockEntities = new Map(Object.entries(opts.blockEntities ?? {}));
    this.containers = new Map(Object.entries(opts.containers ?? {}));
    this.pluginState = new Map(Object.entries(opts.pluginState ?? {}));
    this.inventory = [...(opts.inventory ?? [])];
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

  /**
   * Change a block MID-RUN. This is how a test models DEFERRED state — a plugin's
   * scheduled task writing a block a few ticks after the click that triggered it —
   * which is exactly what `waitForBlock` exists for and what an assert-once read flakes on.
   */
  setBlock(pos: { x: number; y: number; z: number }, type: string, properties?: Record<string, string>): void {
    this.blocks.set(posKey(pos), type);
    if (properties) this.blockProperties.set(posKey(pos), properties);
  }

  /** Set a plugin-state value mid-run (the `waitForPluginState` counterpart of `setBlock`). */
  setPluginState(query: string, value: unknown): void {
    this.pluginState.set(query, value);
  }

  /**
   * Answer the SUT's plugin-state queries from the mock's OWN model, so an
   * action→truth assertion (`click Spawn` ⇒ `regions.active == "Spawn"`) is
   * proved by state the click actually changed rather than by a value the test
   * seeded — the same shape the real Bukkit agent answers. Explicitly seeded
   * values (`opts.pluginState`) still win, for negative controls.
   */
  private derivedState(query: string, args: unknown): unknown {
    const name = (args as { name?: string } | undefined)?.name;
    if (query === "regions.active") return this.active;
    if (query === "regions.count") return this.entries.length;
    if (query === "regions.exists") return this.entries.some((e) => labelEq(e, name));
    return null;
  }

  private elements(): { label: string; slot: number }[] {
    if (this.screen === "root") return [{ label: this.regionsLabel, slot: 4 }];
    if (this.screen === "list") {
      const out = this.entries.map((label, i) => ({ label, slot: 10 + i * 2 }));
      out.push({ label: "Create", slot: 22 });
      out.push({ label: "Delete", slot: 24 });
      return out;
    }
    return [];
  }

  private onMessage(ws: WebSocket, raw: string): void {
    let req: { id?: number | string; method?: string; params?: Record<string, unknown> };
    try {
      req = JSON.parse(raw);
    } catch {
      return;
    }
    if (req.id === undefined || req.method === undefined) return;
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
            data: { reason: e.reason ?? "internalError", retryable: e.reason === "ELEMENT_NOT_FOUND", ...(e.data ?? {}) },
          },
        }),
      );
    }
  }

  private err(code: number, reason: string, message: string, data?: Record<string, unknown>): never {
    throw { code, reason, message, data };
  }

  private dispatch(method: string, params: Record<string, unknown>): unknown {
    switch (method) {
      case "session.create": {
        const required = (params["requiredCapabilities"] as string[] | undefined) ?? [];
        const unmet = required.filter((c) => !this.caps.includes(c));
        if (unmet.length) this.err(-32002, "METHOD_NOT_SUPPORTED", "missing caps", { unmet, offered: this.caps });
        return {
          ok: true,
          sessionId: "s_mock",
          protocolVersion: "1.0",
          agent: { name: "mock-agent", version: "0.0.0", kind: "headlessBot", lang: "ts" },
          target: { minecraft: "1.20.4", loader: "paper" },
          grantedCapabilities: [...this.caps],
          deniedCapabilities: [],
        };
      }
      case "session.describe":
        return {
          ok: true,
          protocolVersion: "1.0",
          supportedProtocols: ["1.0"],
          agent: { name: "mock-agent", version: "0.0.0", kind: "headlessBot" },
          capabilities: [...this.caps],
        };
      case "session.ping":
        return { ok: true, nonce: params["nonce"] };
      case "session.close":
        this.screen = "none";
        this.chat = [];
        return { ok: true };
      case "world.join":
        return { ok: true, playerName: params["username"] ?? "Tester" };
      case "world.leave":
        return { ok: true };
      case "world.sendChat":
        return { ok: true };
      case "world.runCommand": {
        if (String(params["command"]).replace(/^\//, "") === "or") this.screen = "root";
        return { ok: true, screenChanged: true };
      }
      case "world.waitForChat": {
        const filter = params["filter"] as { contains?: string } | undefined;
        const line = this.chat.find((l) => !filter?.contains || l.includes(filter.contains));
        if (!line) this.err(-32003, "TIMEOUT", "no chat");
        return { ok: true, chat: { text: line, sender: "server", channel: "system" } };
      }
      // --- world interaction (cap `worldInteraction`) -------------------------
      case "world.useBlock": {
        const pos = params["pos"] as { x: number; y: number; z: number };
        const face = String(params["face"] ?? "up");
        const type = this.blocks.get(posKey(pos));
        if (!type) this.err(-32004, "WORLD_NOT_READY", `no block at ${posKey(pos)}`);
        const fv = FACE_VECTORS[face];
        if (!fv) this.err(-32602, "invalidParams", `unknown face '${face}'`);
        if (params["sneak"] === true && this.held) {
          // Sneaking suppresses the block's own use behavior, so the held item
          // places against the CLICKED face — the shape placement tests assert.
          const dest = { x: pos.x + fv!.x, y: pos.y + fv!.y, z: pos.z + fv!.z };
          if ((this.blocks.get(posKey(dest)) ?? "minecraft:air") === "minecraft:air") {
            this.blocks.set(posKey(dest), this.held);
            this.chat.push(`Placed ${this.held} at ${posKey(dest)}`);
          } else {
            this.chat.push("face is blocked");
          }
          return { ok: true, screenChanged: false, block: { type }, face, sneak: true, held: { type: this.held } };
        }
        // Non-sneaking click on a container opens its GUI.
        const opens = type!.endsWith("chest") || type!.endsWith("barrel");
        return {
          ok: true,
          screenChanged: opens,
          block: { type },
          face,
          sneak: params["sneak"] === true,
          held: { type: this.held },
        };
      }
      case "world.attackBlock": {
        const pos = params["pos"] as { x: number; y: number; z: number };
        const face = String(params["face"] ?? "up");
        const type = this.blocks.get(posKey(pos));
        if (!type) this.err(-32004, "WORLD_NOT_READY", `no block at ${posKey(pos)}`);
        const broken = params["breakBlock"] === true;
        if (broken) this.blocks.delete(posKey(pos));
        this.chat.push(`Attacked ${type} at ${posKey(pos)}`);
        return { ok: true, block: { type }, face, broken };
      }
      case "world.setHeldItem": {
        if (typeof params["slot"] === "number") {
          this.heldSlot = params["slot"] as number;
          this.held = this.inventory[this.heldSlot] ?? null;
          return { ok: true, held: { type: this.held, slot: this.heldSlot } };
        }
        const want = String(params["item"] ?? "").replace(/^minecraft:/, "");
        const idx = this.inventory.findIndex((i) => i.replace(/^minecraft:/, "") === want);
        if (idx === -1) {
          this.err(-32000, "ELEMENT_NOT_FOUND", `no inventory stack matches '${String(params["item"])}'`);
        }
        this.heldSlot = idx;
        this.held = this.inventory[idx]!;
        return { ok: true, held: { type: this.held, count: 1, slot: idx } };
      }
      case "world.look": {
        if (typeof params["yaw"] === "number") this.yaw = params["yaw"] as number;
        if (typeof params["pitch"] === "number") this.pitch = params["pitch"] as number;
        if (params["at"]) {
          // Deterministic stand-in: aiming at a point simply records it as faced.
          this.pitch = 0;
        }
        return { ok: true, yaw: this.yaw, pitch: this.pitch, position: { x: 0, y: 64, z: 0 } };
      }
      case "world.move": {
        if (params["stop"] === true) {
          this.controls = [];
          return { ok: true, held: [], position: { x: 0, y: 64, z: 0 }, warnings: ["all control states released"] };
        }
        const controls = (params["controls"] as Record<string, boolean> | undefined) ?? {};
        const on = Object.keys(controls).filter((k) => controls[k] === true);
        this.controls = params["durationMs"] !== undefined ? [] : on;
        return { ok: true, held: [...this.controls], position: { x: 0, y: 64, z: 0 } };
      }
      case "truth.getWorldBlock": {
        const key = posKey({
          x: Number(params["x"]),
          y: Number(params["y"]),
          z: Number(params["z"]),
        });
        const props = this.blockProperties.get(key);
        // A block-entity document is present ONLY where one was seeded — a container's
        // contents surface through it exactly as the real agent renders them.
        let nbt = this.blockEntities.get(key);
        const container = this.containers.get(key);
        if (container) {
          const items = Object.entries(container)
            .map(([slot, item]) => ({
              Slot: Number(slot),
              id: item.type,
              count: item.count ?? 1,
              components: item.components ?? {},
            }))
            .sort((a, b) => a.Slot - b.Slot);
          nbt = { ...(nbt ?? {}), Items: items };
        }
        return {
          ok: true,
          block: {
            type: this.blocks.get(key) ?? "minecraft:air",
            ...(props ? { properties: props } : {}),
            ...(nbt ? { nbt, nbtJson: canonical(nbt) } : {}),
          },
        };
      }
      case "truth.assertPluginState": {
        const query = String(params["query"] ?? "");
        const value = this.pluginState.has(query) ? this.pluginState.get(query) : this.derivedState(query, params["args"]);
        const expect = (params["expect"] as Record<string, unknown> | undefined) ?? {};
        let matched: boolean | null = null;
        if ("equals" in expect) matched = JSON.stringify(value) === JSON.stringify(expect["equals"]);
        else if ("notEquals" in expect) matched = JSON.stringify(value) !== JSON.stringify(expect["notEquals"]);
        else if ("exists" in expect) matched = (value !== null && value !== undefined) === (expect["exists"] === true);
        return { ok: true, query, value, matched, valueJson: JSON.stringify(value) };
      }
      case "truth.getContainer": {
        const key = posKey({
          x: Number(params["x"]),
          y: Number(params["y"]),
          z: Number(params["z"]),
        });
        const contents = this.containers.get(key);
        if (!contents) {
          this.err(-32602, "invalidParams", `Block at ${key} is ${this.blocks.get(key) ?? "minecraft:air"}, not a container`);
        }
        const size = 27;
        const slots: Record<string, unknown>[] = [];
        for (let slot = 0; slot < size; slot++) {
          const item = contents![String(slot)];
          if (!item) {
            if (params["includeEmpty"] === true) {
              slots.push({ type: "minecraft:air", count: 0, slot });
            }
            continue;
          }
          slots.push(describeMockItem(item, slot));
        }
        return {
          ok: true,
          container: {
            type: this.blocks.get(key) ?? "minecraft:chest",
            size,
            itemCount: Object.keys(contents!).length,
            slots,
          },
        };
      }
      case "truth.getItem": {
        const key = posKey({
          x: Number(params["x"]),
          y: Number(params["y"]),
          z: Number(params["z"]),
        });
        const contents = this.containers.get(key);
        if (!contents) {
          this.err(-32602, "invalidParams", `Block at ${key} is not a container`);
        }
        const slot = Number(params["slot"]);
        if (!Number.isInteger(slot) || slot < 0 || slot >= 27) {
          this.err(-32602, "invalidParams", `slot ${slot} out of range for a 27-slot inventory`);
        }
        const item = contents![String(slot)];
        return { ok: true, slot, item: item ? describeMockItem(item, slot) : null };
      }
      case "screen.waitForScreen": {
        const match = params["match"] as { title?: string } | undefined;
        const title = this.screen === "root" ? "OpenRegions" : this.screen === "list" ? "Regions" : "";
        if (this.screen === "none") this.err(-32003, "TIMEOUT", "no screen");
        if (match?.title && !title.toLowerCase().includes(match.title.toLowerCase())) {
          this.err(-32003, "TIMEOUT", "screen title mismatch");
        }
        return { ok: true, screen: { screenId: `screen:${this.screen}`, kind: "containerGui", title, elements: [] } };
      }
      case "screen.get":
        return {
          ok: true,
          screen: {
            screenId: `screen:${this.screen}`,
            kind: this.screen === "none" ? "none" : "containerGui",
            elements: this.elements().map((e, i) => ({ elementId: `el_${i}`, label: e.label, slot: e.slot })),
          },
        };
      case "screen.listElements": {
        const els = this.elements();
        return { ok: true, count: els.length, elements: els.map((e, i) => ({ elementId: `el_${i}`, label: e.label, slot: e.slot })) };
      }
      case "screen.clickElement": {
        const selector = params["selector"] as { label?: string; testId?: string };
        const isEntry = this.screen === "list" && this.entries.some((e) => labelEq(e, selector.label));
        // Simulate a list that populates a few polls late (SelectorWaits exercise): an entry click
        // 404s until listReveals is exhausted, then resolves.
        if (isEntry && this.listReveals > 0) {
          this.listReveals--;
          this.err(-32000, "ELEMENT_NOT_FOUND", "list not ready", { selector });
        }
        const match = this.elements().find((e) => labelEq(e.label, selector.label));
        if (!match) this.err(-32000, "ELEMENT_NOT_FOUND", "no element", { selector, candidatesConsidered: this.elements().length });
        if (this.screen === "root" && labelEq(match!.label, this.regionsLabel)) {
          this.screen = "list";
          return { ok: true, screenChanged: true, resolved: { via: "label", slot: match!.slot } };
        }
        if (this.screen === "list") {
          if (isEntry) {
            // Load: mark active + emit the chat line (mirrors the SUT's action→chat).
            this.active = match!.label;
            this.chat.push(`Region loaded: ${match!.label}`);
          } else if (labelEq(match!.label, "Create")) {
            this.chat.push(`Region created: ${CREATE_REGION}`);
          } else if (labelEq(match!.label, "Delete") && this.active) {
            this.chat.push(`Region deleted: ${this.active}`);
            this.active = null;
          }
        }
        return { ok: true, screenChanged: false, resolved: { via: "label", slot: match!.slot } };
      }
      default:
        this.err(-32002, "METHOD_NOT_SUPPORTED", `mock has no ${method}`);
    }
  }
}
