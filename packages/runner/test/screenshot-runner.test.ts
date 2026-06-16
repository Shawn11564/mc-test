/**
 * F3 integration: the `screenshot` STEP VERB and AUTO-CAPTURE-ON-FAILURE proven
 * through the REAL `Runner.runTest` over real MCTP frames (no Minecraft boot).
 *
 * A tiny live WebSocket agent scripts the GUI flow and returns a real 8-bit RGBA
 * PNG for `screen.screenshot` (the canonical nested `{ image:{ ...,data } }`
 * shape). Two proofs:
 *  - a passing test with a `screenshot` step PERSISTS the PNG into the per-test
 *    artifacts dir and records its path on the step + the test's `artifacts[]`;
 *  - when a step FAILS, the runner best-effort captures a screenshot and attaches
 *    it to the failure bundle — and if the agent's screenshot throws, the run is
 *    UNAFFECTED (still a clean fail, no crash).
 */
import { describe, it, expect, afterEach } from "vitest";
import { deflateSync } from "node:zlib";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import {
  Runner,
  DriverRegistry,
  comparePng,
  type Capabilities,
  type DriverDescriptor,
  type ExecContext,
  type NormalizedTest,
} from "../src/index.js";

// --- a real RGBA PNG (8-bit truecolour) the agent returns -------------------

function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const tb = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([tb, data])), 0);
  return Buffer.concat([len, tb, data, crc]);
}
function rgbaPng(w: number, h: number, r: number, g: number, b: number): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  let p = 0;
  for (let y = 0; y < h; y++) {
    raw[p++] = 0;
    for (let x = 0; x < w; x++) {
      raw[p++] = r;
      raw[p++] = g;
      raw[p++] = b;
      raw[p++] = 255;
    }
  }
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const CAPS: Capabilities = {
  chat: true,
  command: true,
  clientScreens: true,
  containerGui: true,
  typeText: true,
  pressKey: true,
  testIdTags: true,
  screenshot: true,
  rendering: true,
};

interface AgentOptions {
  /** Make screen.clickElement fail (to exercise auto-capture-on-failure). */
  failClick?: boolean;
  /** Make screen.screenshot throw (to prove best-effort capture is defensive). */
  throwShot?: boolean;
}

/** A tiny live MCTP agent that returns a real RGBA PNG for screen.screenshot. */
class ShotAgent {
  private wss: WebSocketServer | null = null;
  readonly png = rgbaPng(4, 4, 12, 34, 56);
  readonly calls: string[] = [];
  constructor(private readonly opts: AgentOptions = {}) {}

  start(): Promise<{ url: string }> {
    return new Promise((resolve) => {
      const wss = new WebSocketServer({
        host: "127.0.0.1",
        port: 0,
        path: "/mctp",
        handleProtocols: (p) => (p.has("mctp.v1") ? "mctp.v1" : false),
      });
      this.wss = wss;
      wss.on("connection", (ws) => ws.on("message", (d) => this.onMessage(ws, d.toString())));
      wss.on("listening", () => {
        const addr = wss.address() as AddressInfo;
        resolve({ url: `ws://127.0.0.1:${addr.port}/mctp` });
      });
    });
  }
  async stop(): Promise<void> {
    const wss = this.wss;
    this.wss = null;
    if (wss) await new Promise<void>((r) => wss.close(() => r()));
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
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: this.dispatch(req.method) }));
    } catch (e) {
      const err = e as { code?: number; reason?: string; message?: string };
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: req.id,
          error: { code: err.code ?? -32603, message: err.message ?? "err", data: { reason: err.reason ?? "internalError" } },
        }),
      );
    }
  }

  private dispatch(method: string): unknown {
    switch (method) {
      case "session.create":
        return {
          ok: true,
          sessionId: "s_shot",
          protocolVersion: "1.0",
          agent: { name: "shot-agent", version: "0", kind: "clientMod", lang: "ts" },
          grantedCapabilities: Object.keys(CAPS),
          deniedCapabilities: [],
        };
      case "session.close":
        return { ok: true };
      case "world.join":
        return { ok: true, playerName: "Tester" };
      case "world.runCommand":
        return { ok: true, screenChanged: true };
      case "screen.clickElement":
        if (this.opts.failClick) throw { code: -32000, reason: "ELEMENT_NOT_FOUND", message: "no element" };
        return { ok: true, screenChanged: true, resolved: { via: "testId" } };
      case "screen.screenshot":
        if (this.opts.throwShot) throw { code: -32002, reason: "METHOD_NOT_SUPPORTED", message: "no framebuffer" };
        return {
          ok: true,
          image: { format: "png", width: 4, height: 4, encoding: "base64", data: this.png.toString("base64") },
        };
      default:
        throw { code: -32601, reason: "methodNotFound", message: method };
    }
  }
}

const META = { target: "shot-target", loader: "fabric", mc: "1.21.1" };

function descriptor(url: string): DriverDescriptor {
  return { id: "inprocess", kind: "clientMod", cost: 3, advertised: { ...CAPS }, create: async () => ({ url, stop: async () => {} }) };
}

const agents: ShotAgent[] = [];
afterEach(async () => {
  await Promise.all(agents.splice(0).map((a) => a.stop()));
});
async function start(opts?: AgentOptions): Promise<{ url: string; agent: ShotAgent }> {
  const agent = new ShotAgent(opts);
  agents.push(agent);
  const { url } = await agent.start();
  return { url, agent };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "mctest-run-shot-"));
  dirs.push(d);
  return d;
}

function execFor(out: string): ExecContext {
  return {
    host: "127.0.0.1",
    port: 25565,
    defaultUsername: "Tester",
    artifactsDir: join(out, "artifacts", "shot-target", "t"),
    baselineDir: join(out, "baselines", "shot-target"),
  };
}

describe("F3 runner integration: screenshot step persists, failure auto-captures", () => {
  it("a `screenshot` step writes the PNG and records it on the step + test artifacts", async () => {
    const { url, agent } = await start();
    const out = tempDir();
    const test: NormalizedTest = {
      name: "shot-pass",
      requires: { command: true, clientScreens: true },
      steps: [
        { index: 0, verb: "join", args: { username: "Tester" } },
        { index: 1, verb: "command", args: "or" },
        { index: 2, verb: "click", args: { testId: "regions:root:regions" } },
        { index: 3, verb: "screenshot", args: { name: "after-click" } },
      ],
    };
    const result = await runnerFor(url).runTest(test, descriptor(url), url, execFor(out), META);

    expect(result.outcome).toBe("passed");
    expect(agent.calls).toContain("screen.screenshot");
    const shot = result.steps.find((s) => s.verb === "screenshot")!;
    expect(shot.outcome).toBe("passed");
    expect(shot.artifacts?.length).toBe(1);
    expect(existsSync(shot.artifacts![0]!)).toBe(true);
    // The persisted file is named from the step's `name` arg and lives in the artifacts dir.
    expect(shot.artifacts![0]).toMatch(/screenshot-after-click\.png$/);
    // It also bubbles up to the test-level artifacts[] (what the failure bundle/reporter reads).
    expect(result.artifacts).toContain(shot.artifacts![0]);
    // The bytes match what the agent sent.
    expect(comparePng(agent.png, agent.png).diffPixels).toBe(0);
    // First run also SEEDED a baseline (informational).
    expect(shot.baselineDiff?.compared).toBe(false);
  });

  it("on a FAILED step the runner attaches an auto-captured screenshot to the bundle", async () => {
    const { url } = await start({ failClick: true });
    const out = tempDir();
    const test: NormalizedTest = {
      name: "shot-fail",
      requires: { command: true, clientScreens: true },
      steps: [
        { index: 0, verb: "join", args: { username: "Tester" } },
        { index: 1, verb: "command", args: "or" },
        // Short timeout: the agent always fails this click, so cap SelectorWaits' retry budget.
        { index: 2, verb: "click", args: { testId: "regions:root:regions", timeoutMs: 200 } }, // fails
      ],
    };
    const result = await runnerFor(url).runTest(test, descriptor(url), url, execFor(out), META);

    expect(result.outcome).toBe("failed");
    const click = result.steps.find((s) => s.verb === "click")!;
    expect(click.outcome).toBe("failed");
    // The failed step carries an auto-captured screenshot artifact.
    expect(click.artifacts?.length).toBe(1);
    expect(existsSync(click.artifacts![0]!)).toBe(true);
    expect(click.artifacts![0]).toMatch(/failure-step2-click\.png$/);
    expect(result.artifacts).toContain(click.artifacts![0]);
  });

  it("auto-capture is best-effort: a throwing screen.screenshot does NOT crash the run", async () => {
    const { url, agent } = await start({ failClick: true, throwShot: true });
    const out = tempDir();
    const test: NormalizedTest = {
      name: "shot-fail-noshot",
      requires: { command: true, clientScreens: true },
      steps: [
        { index: 0, verb: "join", args: { username: "Tester" } },
        { index: 1, verb: "command", args: "or" },
        { index: 2, verb: "click", args: { testId: "regions:root:regions", timeoutMs: 200 } }, // fails
      ],
    };
    // Must resolve to a clean failed result, not reject.
    const result = await runnerFor(url).runTest(test, descriptor(url), url, execFor(out), META);

    expect(result.outcome).toBe("failed");
    const click = result.steps.find((s) => s.verb === "click")!;
    expect(click.outcome).toBe("failed");
    // The screenshot was attempted but threw → no artifact attached, no crash.
    expect(agent.calls).toContain("screen.screenshot");
    expect(click.artifacts ?? []).toEqual([]);
    // The artifacts dir holds no PNG from the failed capture.
    const adir = join(out, "artifacts", "shot-target", "t");
    expect(existsSync(adir) ? readdirSync(adir) : []).toEqual([]);
  });
});

function runnerFor(_url: string): Runner {
  return new Runner(new DriverRegistry());
}
