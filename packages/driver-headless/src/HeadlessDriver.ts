/**
 * The headless driver: a real MCTP WebSocket server (JSON-RPC 2.0) backed by a
 * Mineflayer protocol bot. The runner connects to it exactly as it would to a
 * JVM agent — there is no in-process shortcut on the wire.
 *
 * Selector resolution, container reads, and chat waits are delegated to the
 * primitives; all retry/assertion/orchestration intelligence stays in the runner.
 */
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { createBot, type Bot } from "mineflayer";
import {
  MCTP_ERROR_CODES,
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOLS,
  type Selector,
} from "@mc-test/protocol";
import { HEADLESS_AGENT_KIND, HEADLESS_CAPABILITY_KEYS } from "./capabilities.js";
import {
  containerElements,
  screenMatches,
  snapshot,
  toProtocolElement,
} from "./primitives/containerGui.js";
import { primaryVia, resolveSelector } from "./primitives/selectorResolve.js";
import { runCommand, sendChat, waitForChat, type ChatRecord } from "./primitives/world.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** An MCTP error carrying a canonical code + reason token. */
class McptError extends Error {
  constructor(
    readonly code: number,
    readonly reason: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
}

function isExactVersion(s: string | undefined): s is string {
  return typeof s === "string" && /^\d+\.\d+(\.\d+)?$/.test(s.trim());
}

/**
 * One headless driver instance hosts one MCTP endpoint and (after `world.join`)
 * one Mineflayer bot. Construct, `start()` to get the ws URL, then `stop()`.
 */
export class HeadlessDriver {
  private wss: WebSocketServer | null = null;
  private bot: Bot | null = null;
  private readonly chat: ChatRecord[] = [];
  private chatSeq = 0;
  private sessionId: string | null = null;
  private mcVersion = "1.20.4";
  private loader = "paper";
  private url = "";

  /** Start the MCTP WebSocket server on an ephemeral loopback port. */
  start(): Promise<{ url: string }> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({
        host: "127.0.0.1",
        port: 0,
        path: "/mctp",
        handleProtocols: (protocols) => (protocols.has("mctp.v1") ? "mctp.v1" : false),
      });
      this.wss = wss;
      wss.on("error", reject);
      wss.on("connection", (ws) => this.onConnection(ws));
      wss.on("listening", () => {
        const addr = wss.address() as AddressInfo;
        this.url = `ws://127.0.0.1:${addr.port}/mctp`;
        resolve({ url: this.url });
      });
    });
  }

  /** The MCTP endpoint URL (valid after `start`). */
  get endpoint(): string {
    return this.url;
  }

  /** Quit the bot and close the server. */
  async stop(): Promise<void> {
    if (this.bot) {
      try {
        this.bot.quit();
      } catch {
        /* already gone */
      }
      this.bot = null;
    }
    if (this.wss) {
      const wss = this.wss;
      this.wss = null;
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  }

  private onConnection(ws: WebSocket): void {
    ws.on("message", (data) => {
      void this.handleMessage(ws, data.toString());
    });
  }

  private async handleMessage(ws: WebSocket, raw: string): Promise<void> {
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(raw) as JsonRpcRequest;
    } catch {
      this.sendError(ws, null, MCTP_ERROR_CODES.PARSE_ERROR, "parseError", "Invalid JSON");
      return;
    }
    if (req.id === undefined || req.method === undefined) {
      return; // notifications / malformed: nothing to answer
    }
    try {
      const result = await this.dispatch(req.method, req.params ?? {});
      this.send(ws, { jsonrpc: "2.0", id: req.id, result });
    } catch (err) {
      if (err instanceof McptError) {
        this.sendError(ws, req.id, err.code, err.reason, err.message, err.details);
      } else {
        const message = err instanceof Error ? err.message : String(err);
        this.sendError(ws, req.id, MCTP_ERROR_CODES.INTERNAL_ERROR, "internalError", message);
      }
    }
  }

  private async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "session.create":
        return this.sessionCreate(params);
      case "session.describe":
        return this.sessionDescribe();
      case "session.ping":
        return { ok: true, nonce: params["nonce"] };
      case "session.close":
        return this.sessionClose();
      case "world.join":
        return this.worldJoin(params);
      case "world.leave":
        return this.worldLeave();
      case "world.sendChat":
        sendChat(this.requireBot(), String(params["message"] ?? ""));
        return { ok: true };
      case "world.runCommand":
        runCommand(this.requireBot(), String(params["command"] ?? ""));
        return { ok: true, screenChanged: false };
      case "world.waitForChat":
        return this.worldWaitForChat(params);
      case "screen.get":
        return { ok: true, screen: snapshot(this.requireBot()) };
      case "screen.listElements":
        return this.screenListElements(params);
      case "screen.clickElement":
        return this.screenClickElement(params);
      case "screen.waitForScreen":
        return this.screenWaitForScreen(params);
      case "screen.close":
        return this.screenClose();
      case "screen.typeText":
        return this.screenTypeText();
      case "screen.pressKey":
        return this.screenPressKey(params);
      default:
        throw new McptError(
          MCTP_ERROR_CODES.METHOD_NOT_SUPPORTED,
          "METHOD_NOT_SUPPORTED",
          `Method '${method}' not supported by the headless driver`,
        );
    }
  }

  // --- session ---------------------------------------------------------------

  private sessionCreate(params: Record<string, unknown>): unknown {
    const required = (params["requiredCapabilities"] as string[] | undefined) ?? [];
    const advertised = HEADLESS_CAPABILITY_KEYS as string[];
    const unmet = required.filter((c) => !advertised.includes(c));
    if (unmet.length > 0) {
      throw new McptError(
        MCTP_ERROR_CODES.METHOD_NOT_SUPPORTED,
        "METHOD_NOT_SUPPORTED",
        "Required capabilities not available",
        { unmet, offered: advertised, agentKind: HEADLESS_AGENT_KIND },
      );
    }
    const constraints = (params["constraints"] as Record<string, unknown> | undefined) ?? {};
    if (isExactVersion(constraints["mcVersionRange"] as string | undefined)) {
      this.mcVersion = (constraints["mcVersionRange"] as string).trim();
    }
    if (typeof constraints["loader"] === "string") this.loader = constraints["loader"] as string;

    this.sessionId = `s_${randomUUID().slice(0, 8)}`;
    const optional = (params["optionalCapabilities"] as string[] | undefined) ?? [];
    return {
      ok: true,
      sessionId: this.sessionId,
      protocolVersion: PROTOCOL_VERSION,
      agent: {
        name: "mc-test-driver-headless",
        version: "0.1.0",
        kind: HEADLESS_AGENT_KIND,
        lang: "ts",
      },
      target: { minecraft: this.mcVersion, loader: this.loader },
      grantedCapabilities: [...advertised],
      deniedCapabilities: optional.filter((c) => !advertised.includes(c)),
      capabilityDetails: { containerGui: { version: 1, screenModel: "containerSlots" } },
    };
  }

  private sessionDescribe(): unknown {
    return {
      ok: true,
      protocolVersion: PROTOCOL_VERSION,
      supportedProtocols: [...SUPPORTED_PROTOCOLS],
      agent: { name: "mc-test-driver-headless", version: "0.1.0", kind: HEADLESS_AGENT_KIND },
      capabilities: [...HEADLESS_CAPABILITY_KEYS],
    };
  }

  private async sessionClose(): Promise<unknown> {
    await this.stopBot();
    this.sessionId = null;
    return { ok: true };
  }

  // --- world -----------------------------------------------------------------

  private async worldJoin(params: Record<string, unknown>): Promise<unknown> {
    const host = String(params["host"] ?? "127.0.0.1");
    const port = Number(params["port"] ?? 25565);
    const username = String(params["username"] ?? "Tester");
    const joinTimeoutMs = Number(params["joinTimeoutMs"] ?? 60000);

    const bot = createBot({ host, port, username, version: this.mcVersion, auth: "offline" });
    this.bot = bot;
    bot.on("messagestr", (msg: string) => {
      this.chat.push({ seq: this.chatSeq++, plain: msg });
      if (this.chat.length > 500) this.chat.shift();
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => {
          bot.removeListener("spawn", onSpawn);
          bot.removeListener("error", onError as never);
          bot.removeListener("end", onEnd as never);
          clearTimeout(timer);
        };
        const onSpawn = (): void => {
          cleanup();
          resolve();
        };
        const onError = (e: Error): void => {
          cleanup();
          reject(e);
        };
        const onEnd = (reason: string): void => {
          cleanup();
          reject(new Error(`disconnected before spawn: ${reason}`));
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error("join timeout"));
        }, joinTimeoutMs);
        bot.once("spawn", onSpawn);
        bot.once("error", onError as never);
        bot.once("end", onEnd as never);
      });
    } catch (err) {
      await this.stopBot();
      throw new McptError(
        MCTP_ERROR_CODES.WORLD_NOT_READY,
        "WORLD_NOT_READY",
        `world.join failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const entity = bot.entity as { position?: { x: number; y: number; z: number } } | undefined;
    return {
      ok: true,
      playerName: bot.username,
      dimension: bot.game?.dimension,
      position: entity?.position
        ? { x: entity.position.x, y: entity.position.y, z: entity.position.z }
        : undefined,
      serverBrand: (bot as unknown as { game?: { serverBrand?: string } }).game?.serverBrand,
    };
  }

  private async worldLeave(): Promise<unknown> {
    await this.stopBot();
    return { ok: true };
  }

  private async worldWaitForChat(params: Record<string, unknown>): Promise<unknown> {
    const bot = this.requireBot();
    const filter = params["filter"] as Parameters<typeof waitForChat>[2];
    const timeoutMs = Number(params["timeoutMs"] ?? 5000);
    try {
      const chat = await waitForChat(bot, this.chat, filter, timeoutMs);
      return { ok: true, chat };
    } catch {
      throw new McptError(MCTP_ERROR_CODES.TIMEOUT, "TIMEOUT", "world.waitForChat timed out", {
        filter,
      });
    }
  }

  // --- screen ----------------------------------------------------------------

  private screenListElements(params: Record<string, unknown>): unknown {
    const bot = this.requireBot();
    const elements = containerElements(bot);
    const selector = params["selector"] as Selector | undefined;
    const filtered = selector ? resolveSelector(selector, elements).matches : elements;
    return { ok: true, count: filtered.length, elements: filtered.map(toProtocolElement) };
  }

  private async screenClickElement(params: Record<string, unknown>): Promise<unknown> {
    const bot = this.requireBot();
    const selector = params["selector"] as Selector;
    const elements = containerElements(bot);
    const { matches } = resolveSelector(selector, elements);
    if (matches.length === 0) {
      throw new McptError(
        MCTP_ERROR_CODES.ELEMENT_NOT_FOUND,
        "ELEMENT_NOT_FOUND",
        "No element matched selector",
        { selector, candidatesConsidered: elements.length },
      );
    }
    if (matches.length > 1 && selector.index === undefined && selector.nth === undefined) {
      throw new McptError(
        MCTP_ERROR_CODES.AMBIGUOUS_SELECTOR,
        "AMBIGUOUS_SELECTOR",
        `Selector matched ${matches.length} elements`,
        { matches: matches.map((m) => m.slot) },
      );
    }
    const target = matches[0]!;
    const beforeId = (bot.currentWindow as { id?: number } | null)?.id ?? null;
    try {
      await bot.clickWindow(target.slot, 0, 0);
    } catch {
      // GUI "button" clicks are cancelled server-side and frequently reject the
      // transaction in Mineflayer; the click packet was still delivered.
    }
    await sleep(80);
    const afterId = (bot.currentWindow as { id?: number } | null)?.id ?? null;
    return {
      ok: true,
      screenChanged: beforeId !== afterId,
      resolved: { via: primaryVia(selector), slot: target.slot, screenId: `window:${beforeId ?? ""}` },
    };
  }

  private async screenWaitForScreen(params: Record<string, unknown>): Promise<unknown> {
    const bot = this.requireBot();
    const match = params["match"] as Parameters<typeof screenMatches>[1];
    const timeoutMs = Number(params["timeoutMs"] ?? 5000);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const snap = snapshot(bot);
      if (screenMatches(snap, match)) return { ok: true, screen: snap };
      await sleep(100);
    }
    throw new McptError(MCTP_ERROR_CODES.TIMEOUT, "TIMEOUT", "screen.waitForScreen timed out", {
      match,
    });
  }

  private async screenClose(): Promise<unknown> {
    const bot = this.requireBot();
    const window = bot.currentWindow;
    if (window) {
      try {
        bot.closeWindow(window);
      } catch {
        /* already closed */
      }
      return { ok: true, screenChanged: true };
    }
    return { ok: true, screenChanged: false };
  }

  private screenTypeText(): unknown {
    // The bare protocol bot can only type into server-side text inputs
    // (anvil/sign/book); none is open in the canonical flow.
    throw new McptError(
      MCTP_ERROR_CODES.WORLD_NOT_READY,
      "WORLD_NOT_READY",
      "No server-side text input is focused for screen.typeText",
    );
  }

  private async screenPressKey(params: Record<string, unknown>): Promise<unknown> {
    const key = String(params["key"] ?? "").toLowerCase();
    if (key === "escape" || key === "esc") {
      return this.screenClose();
    }
    // A headless bot has no client to receive other key events.
    return { ok: true, screenChanged: false, warnings: ["pressKey is a no-op on the headless bot"] };
  }

  // --- helpers ---------------------------------------------------------------

  private requireBot(): Bot {
    if (!this.bot) {
      throw new McptError(
        MCTP_ERROR_CODES.WORLD_NOT_READY,
        "WORLD_NOT_READY",
        "Not joined to a world (call world.join first)",
      );
    }
    return this.bot;
  }

  private async stopBot(): Promise<void> {
    if (!this.bot) return;
    const bot = this.bot;
    this.bot = null;
    try {
      bot.quit();
    } catch {
      /* already gone */
    }
    await sleep(10);
  }

  private send(ws: WebSocket, payload: unknown): void {
    ws.send(JSON.stringify(payload));
  }

  private sendError(
    ws: WebSocket,
    id: number | string | null,
    code: number,
    reason: string,
    message: string,
    details?: Record<string, unknown>,
  ): void {
    const retryable =
      code === MCTP_ERROR_CODES.ELEMENT_NOT_FOUND ||
      code === MCTP_ERROR_CODES.TIMEOUT ||
      code === MCTP_ERROR_CODES.WORLD_NOT_READY;
    this.send(ws, {
      jsonrpc: "2.0",
      id,
      error: { code, message, data: { reason, retryable, ...(details ?? {}) } },
    });
  }
}
