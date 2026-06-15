/**
 * Step → MCTP mapping (ROADMAP §3.4) + the verb → capability table used for
 * per-step honest skips. Each verb compiles to one or more MCTP calls; the
 * `click` verb is wrapped in SelectorWaits so `ELEMENT_NOT_FOUND` is retried by
 * the runner (never the agent).
 */
import { describeSelector, type Selector, type CapabilityKey, type StepVerb } from "@mc-test/protocol";
import { Session } from "./Session.js";
import { withSelectorWaits } from "./SelectorWaits.js";

/**
 * Capability each step verb implies (checked against the driver's advertised set).
 *
 * NOTE: ROADMAP §3.4 gates the screen verbs on `containerGui` **or**
 * `clientScreens`. M2 ships only the `containerGui` (headless) surface, so the
 * single-key mapping is exact here; when an M4 `clientScreens`-only driver lands,
 * these three entries become an anyOf group.
 */
export const VERB_CAPABILITY: Record<StepVerb, CapabilityKey | null> = {
  join: null,
  leave: null,
  chat: "chat",
  command: "command",
  waitForChat: "chat",
  assertChat: "chat",
  waitForScreen: "containerGui",
  listElements: "containerGui",
  click: "containerGui",
  type: "typeText",
  press: "pressKey",
  screenshot: "screenshot",
  getBlock: "worldTruth",
  getEntities: "worldTruth",
  assertPluginState: "pluginState",
  fixture: "fixtures",
  spawnFakePlayer: "fakePlayers",
};

/** Context the executor needs from provisioning (the live server endpoint). */
export interface ExecContext {
  host: string;
  port: number;
  defaultUsername: string;
}

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

/** Expand a click/selector argument: string → `{ label }` (or `{ testId }` for `#…`). */
function toSelector(v: unknown): Selector {
  if (typeof v === "string") {
    return v.startsWith("#") ? { testId: v.slice(1) } : { label: v };
  }
  const o = asObject(v);
  // A click step's args ARE the selector (minus any non-selector control keys).
  const { timeoutMs: _t, intervalMs: _i, ...rest } = o;
  return rest as Selector;
}

function chatFilter(a: Record<string, unknown>): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  if (typeof a["contains"] === "string") filter["contains"] = a["contains"];
  if (typeof a["regex"] === "string") filter["regex"] = a["regex"];
  if (typeof a["channel"] === "string") filter["channel"] = a["channel"];
  return filter;
}

function screenMatch(a: Record<string, unknown>): Record<string, unknown> {
  const match: Record<string, unknown> = {};
  if (typeof a["titleContains"] === "string") match["title"] = a["titleContains"];
  if (typeof a["screenId"] === "string") match["screenId"] = a["screenId"];
  if (typeof a["screenIdPrefix"] === "string") match["screenIdPrefix"] = a["screenIdPrefix"];
  if (typeof a["kind"] === "string") match["kind"] = a["kind"];
  return match;
}

interface WaitForChatResult {
  chat?: { text?: string };
}
interface WaitForScreenResult {
  screen?: { title?: string };
}
interface ClickResult {
  resolved?: { via?: string };
}
interface PluginStateResult {
  value?: unknown;
  matched?: boolean | null;
}

/**
 * Execute one step against the session, returning a human-readable detail.
 * Throws (an `MctpRpcError` or assertion `Error`) to mark the step — and the
 * test — failed.
 */
export async function executeStep(
  session: Session,
  step: { verb: StepVerb; args: unknown },
  ctx: ExecContext,
): Promise<string> {
  const a = asObject(step.args);
  switch (step.verb) {
    case "join": {
      const username = (a["username"] as string | undefined) ?? ctx.defaultUsername;
      const result = await session.call<{ playerName?: string }>("world.join", {
        host: ctx.host,
        port: ctx.port,
        username,
        auth: "offline",
      });
      return `joined as ${result.playerName ?? username}`;
    }
    case "leave":
      await session.call("world.leave", {});
      return "left world";
    case "chat": {
      const message = typeof step.args === "string" ? step.args : String(a["message"] ?? "");
      await session.call("world.sendChat", { message });
      return `sent chat: ${message}`;
    }
    case "command": {
      const command = typeof step.args === "string" ? step.args : String(a["command"] ?? "");
      await session.call("world.runCommand", { command });
      return `/${command.replace(/^\//, "")}`;
    }
    case "waitForChat":
    case "assertChat": {
      const result = await session.call<WaitForChatResult>("world.waitForChat", {
        filter: chatFilter(a),
        timeoutMs: (a["timeoutMs"] as number | undefined) ?? 10000,
      });
      return `chat matched: "${result.chat?.text ?? ""}"`;
    }
    case "waitForScreen": {
      const result = await session.call<WaitForScreenResult>("screen.waitForScreen", {
        match: screenMatch(a),
        timeoutMs: (a["timeoutMs"] as number | undefined) ?? 10000,
      });
      return `screen opened: "${result.screen?.title ?? ""}"`;
    }
    case "listElements": {
      const result = await session.call<{ count?: number }>("screen.listElements", {
        ...(a["selector"] ? { selector: a["selector"] } : {}),
      });
      return `${result.count ?? 0} element(s)`;
    }
    case "click": {
      const selector = toSelector(step.args);
      const timeoutMs = (a["timeoutMs"] as number | undefined) ?? 6000;
      const result = await withSelectorWaits<ClickResult>(
        () => session.call<ClickResult>("screen.clickElement", { selector }),
        { timeoutMs },
      );
      return `clicked ${describeSelector(selector)} (via ${result.resolved?.via ?? "?"})`;
    }
    case "type": {
      await session.call("screen.typeText", {
        text: String(a["text"] ?? ""),
        ...(a["selector"] ? { selector: a["selector"] } : {}),
        ...(a["clear"] !== undefined ? { clear: a["clear"] } : {}),
        ...(a["submit"] !== undefined ? { submit: a["submit"] } : {}),
      });
      return "typed text";
    }
    case "press": {
      await session.call("screen.pressKey", { key: String(a["key"] ?? "") });
      return `pressed ${String(a["key"] ?? "")}`;
    }
    case "screenshot": {
      await session.call("screen.screenshot", {});
      return "captured screenshot";
    }
    case "getBlock": {
      const result = await session.call<{ block?: { type?: string } }>("truth.getWorldBlock", {
        world: a["world"],
        x: a["x"],
        y: a["y"],
        z: a["z"],
      });
      return `block: ${result.block?.type ?? "?"}`;
    }
    case "getEntities": {
      const result = await session.call<{ count?: number }>("truth.getEntities", a);
      return `${result.count ?? 0} entit(ies)`;
    }
    case "assertPluginState": {
      const result = await session.call<PluginStateResult>("truth.assertPluginState", {
        ...(a["plugin"] ? { plugin: a["plugin"] } : {}),
        query: String(a["query"] ?? ""),
        ...(a["args"] ? { args: a["args"] } : {}),
        ...(a["expect"] !== undefined ? { expect: { equals: a["expect"] } } : {}),
      });
      if (result.matched === false) {
        throw new Error(`pluginState assertion failed: ${String(a["query"])} = ${JSON.stringify(result.value)}`);
      }
      return `pluginState ${String(a["query"])} = ${JSON.stringify(result.value)}`;
    }
    case "fixture": {
      const reset = a["reset"] === true;
      const method = reset ? "fixture.reset" : "fixture.set";
      await session.call(method, reset ? {} : { fixture: String(a["fixture"] ?? a["name"] ?? ""), args: a["args"] });
      return reset ? "fixture reset" : `fixture ${String(a["fixture"] ?? a["name"])}`;
    }
    case "spawnFakePlayer": {
      await session.call("player.spawnFake", {
        name: String(a["name"] ?? a["username"] ?? "Bot2"),
        ...(a["at"] ? { at: a["at"] } : {}),
      });
      return `spawned fake player`;
    }
    default:
      throw new Error(`Unknown step verb: ${String(step.verb)}`);
  }
}
