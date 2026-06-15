/**
 * A tiny in-repo MCTP **client agent** (the in-process / `clientMod` side) for
 * the M4 "testing the tester" layer. It is the rendered-client analog of
 * `mockAgent.ts`: it scripts the SAME regions GUI/chat flow, but advertises the
 * in-process driver's capability set — crucially `clientScreens` (and NOT only
 * `containerGui`) plus `screenshot`/`rendering` — so the runner's verb-level
 * anyOf routing, mixed-driver selection, and combined client+server session are
 * exercised with no Minecraft boot (ROADMAP §7.2; M4 §5.4).
 *
 * Every method it receives is appended to `calls[]`, so a test can prove that
 * GUI verbs land on this client agent (not a co-connected server agent) and vice
 * versa. Options let the advertised cap set be narrowed (e.g. a `containerGui`-
 * only "headless-like" driver, or a `clientScreens`-only driver for the anyOf
 * proof).
 */
import { WebSocketServer, type WebSocket } from "ws";
import type { AddressInfo } from "node:net";

export interface MockClientAgentOptions {
  /** Advertised capability keys (defaults mirror the in-process driver). */
  capabilities?: string[];
  /** The root-menu button label (set to "Zones" for the mutation negative control). */
  regionsButtonLabel?: string;
  /** The list entry label. */
  listEntryLabel?: string;
  /** Chat line emitted when the entry is selected. */
  chatOnSelect?: string;
  /** How many `clickElement(entry)` attempts return ELEMENT_NOT_FOUND before the
   *  list "populates" — exercises runner-side SelectorWaits retries. */
  listAppearAfter?: number;
}

/** The in-process (rendered-client) driver advertises this full set (M4). */
const DEFAULT_CAPS = [
  "chat",
  "command",
  "containerGui",
  "clientScreens",
  "typeText",
  "pressKey",
  "testIdTags",
  "screenshot",
  "rendering",
];

// A 1x1 transparent PNG (so `screen.screenshot` returns a valid base64 image).
const PNG_1x1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function labelEq(a: string | undefined, b: string | undefined): boolean {
  return (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();
}

export class MockClientAgent {
  private wss: WebSocketServer | null = null;
  private url = "";
  private readonly caps: string[];
  private readonly regionsLabel: string;
  private readonly entryLabel: string;
  private readonly chatLine: string;
  private listReveals: number;

  // per-connection-ish state (single session for tests)
  private screen: "none" | "root" | "list" = "none";
  private chat: string[] = [];

  /** Every method this agent received — proves which verbs route here. */
  readonly calls: string[] = [];

  constructor(opts: MockClientAgentOptions = {}) {
    this.caps = opts.capabilities ?? DEFAULT_CAPS;
    this.regionsLabel = opts.regionsButtonLabel ?? "Regions";
    this.entryLabel = opts.listEntryLabel ?? "TestRegion";
    this.chatLine = opts.chatOnSelect ?? "Region loaded: TestRegion";
    this.listReveals = opts.listAppearAfter ?? 0;
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

  private elements(): { label: string; testId: string }[] {
    if (this.screen === "root") return [{ label: this.regionsLabel, testId: "regions:root:regions" }];
    if (this.screen === "list") return [{ label: this.entryLabel, testId: "regions:entry:TestRegion" }];
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
          sessionId: "s_mock_client",
          protocolVersion: "1.0",
          agent: { name: "mock-client-agent", version: "0.0.0", kind: "clientMod", lang: "ts" },
          target: { minecraft: "1.21.1", loader: "fabric" },
          grantedCapabilities: [...this.caps],
          deniedCapabilities: [],
          capabilityDetails: { clientScreens: { widgetTree: true }, screenshot: { format: ["png"] } },
        };
      }
      case "session.describe":
        return {
          ok: true,
          protocolVersion: "1.0",
          supportedProtocols: ["1.0"],
          agent: { name: "mock-client-agent", version: "0.0.0", kind: "clientMod" },
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
      case "screen.waitForScreen": {
        const match = params["match"] as { title?: string } | undefined;
        const title = this.screen === "root" ? "OpenRegions" : this.screen === "list" ? "Regions" : "";
        if (this.screen === "none") this.err(-32003, "TIMEOUT", "no screen");
        if (match?.title && !title.toLowerCase().includes(match.title.toLowerCase())) {
          this.err(-32003, "TIMEOUT", "screen title mismatch");
        }
        return { ok: true, screen: { screenId: `screen:${this.screen}`, kind: "clientScreen", title, elements: [] } };
      }
      case "screen.get":
        return {
          ok: true,
          screen: {
            screenId: `screen:${this.screen}`,
            kind: this.screen === "none" ? "none" : "clientScreen",
            elements: this.elements().map((e, i) => ({ elementId: `el_${i}`, label: e.label, testId: e.testId, role: "button" })),
          },
        };
      case "screen.listElements": {
        const els = this.elements();
        return {
          ok: true,
          count: els.length,
          elements: els.map((e, i) => ({ elementId: `el_${i}`, label: e.label, testId: e.testId, role: "button" })),
        };
      }
      case "screen.clickElement": {
        const selector = params["selector"] as { label?: string; testId?: string };
        const matchEl = (e: { label: string; testId: string }): boolean =>
          (selector.testId !== undefined && selector.testId === e.testId) ||
          (selector.label !== undefined && labelEq(e.label, selector.label));
        // Simulate a list that populates a few polls late (SelectorWaits exercise).
        if (this.screen === "list" && this.listReveals > 0 && this.elements().some(matchEl)) {
          this.listReveals--;
          this.err(-32000, "ELEMENT_NOT_FOUND", "list not ready", { selector });
        }
        const match = this.elements().find(matchEl);
        if (!match) this.err(-32000, "ELEMENT_NOT_FOUND", "no element", { selector, candidatesConsidered: this.elements().length });
        const via = selector.testId !== undefined ? "testId" : "label";
        if (this.screen === "root" && labelEq(match!.label, this.regionsLabel)) {
          this.screen = "list";
          return { ok: true, screenChanged: true, resolved: { via, widgetId: `el_0`, screenId: "screen:root" } };
        }
        if (this.screen === "list" && labelEq(match!.label, this.entryLabel)) {
          this.chat.push(this.chatLine);
          return { ok: true, screenChanged: false, resolved: { via, widgetId: `el_0`, screenId: "screen:list" } };
        }
        return { ok: true, screenChanged: false, resolved: { via, widgetId: `el_0`, screenId: `screen:${this.screen}` } };
      }
      case "screen.typeText":
        return { ok: true, screenChanged: false };
      case "screen.pressKey":
        return { ok: true, screenChanged: false };
      case "screen.screenshot":
        return { ok: true, format: "png", image: PNG_1x1_BASE64, encoding: "base64" };
      case "screen.close":
        this.screen = "none";
        return { ok: true, screenChanged: true };
      default:
        this.err(-32002, "METHOD_NOT_SUPPORTED", `mock client agent has no ${method}`);
    }
  }
}
