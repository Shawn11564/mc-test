/**
 * A tiny in-repo MCTP agent (WebSocket server) that scripts the regions flow.
 * It lets us unit-test the WHOLE engine — capability negotiation, step→MCTP
 * mapping, SelectorWaits retry/timeout, honest skips, JUnit output — with no
 * Minecraft boot (ROADMAP §7.2). Configurable for negative controls.
 */
import { WebSocketServer, type WebSocket } from "ws";
import type { AddressInfo } from "node:net";

export interface MockAgentOptions {
  /** Advertised capability keys (defaults mirror the headless driver). */
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

const DEFAULT_CAPS = ["chat", "command", "containerGui", "typeText", "pressKey"];

function labelEq(a: string | undefined, b: string | undefined): boolean {
  return (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();
}

export class MockAgent {
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

  constructor(opts: MockAgentOptions = {}) {
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

  private elements(): { label: string; slot: number }[] {
    if (this.screen === "root") return [{ label: this.regionsLabel, slot: 4 }];
    if (this.screen === "list") return [{ label: this.entryLabel, slot: 11 }];
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
        // Simulate a list that populates a few polls late (SelectorWaits exercise).
        if (this.screen === "list" && labelEq(selector.label, this.entryLabel) && this.listReveals > 0) {
          this.listReveals--;
          this.err(-32000, "ELEMENT_NOT_FOUND", "list not ready", { selector });
        }
        const match = this.elements().find((e) => labelEq(e.label, selector.label));
        if (!match) this.err(-32000, "ELEMENT_NOT_FOUND", "no element", { selector, candidatesConsidered: this.elements().length });
        if (this.screen === "root" && labelEq(match!.label, this.regionsLabel)) {
          this.screen = "list";
          return { ok: true, screenChanged: true, resolved: { via: "label", slot: match!.slot } };
        }
        if (this.screen === "list" && labelEq(match!.label, this.entryLabel)) {
          this.chat.push(this.chatLine);
          return { ok: true, screenChanged: false, resolved: { via: "label", slot: match!.slot } };
        }
        return { ok: true, screenChanged: false, resolved: { via: "label", slot: match!.slot } };
      }
      default:
        this.err(-32002, "METHOD_NOT_SUPPORTED", `mock has no ${method}`);
    }
  }
}
