/**
 * Step → MCTP mapping (ROADMAP §3.4) + the verb → capability table used for
 * per-step honest skips and **connection routing**. Each verb compiles to one or
 * more MCTP calls; the `click` verb is wrapped in SelectorWaits so
 * `ELEMENT_NOT_FOUND` is retried by the runner (never the agent).
 *
 * Multi-connection (M3): the executor no longer takes a single `Session`. It
 * takes a `SessionRouter` and resolves each verb to the right connection via
 * `VERB_CAPABILITY[verb]` — GUI/chat verbs fan to the driver, truth/fixture/
 * player verbs fan to the server agent. The author writes no connection plumbing.
 */
import { describeSelector, type Selector, type CapabilityKey, type StepVerb } from "@mc-test/protocol";
import { Session } from "./Session.js";
import { withSelectorWaits } from "./SelectorWaits.js";
import { captureScreenshot, type ScreenshotArtifact } from "../report/screenshots.js";

/**
 * A step verb's capability requirement: a single key, an **anyOf** group (the
 * union is satisfied if it advertises ANY member), or `null` (no requirement).
 * The three screen-navigation verbs are anyOf groups so they route to EITHER a
 * `containerGui` (headless) driver OR a `clientScreens` (in-process) driver.
 */
export type StepCapReq = CapabilityKey | readonly CapabilityKey[] | null;

/**
 * Capability each step verb implies (checked against the driver's advertised set).
 *
 * ROADMAP §3.4 gates the screen-navigation verbs on `containerGui` **or**
 * `clientScreens` — so `waitForScreen`/`listElements`/`click` are **anyOf** groups
 * (M4): they route to whichever driver advertises either key. `type`/`press`/
 * `screenshot` stay single-keyed — both GUI drivers advertise `typeText`/
 * `pressKey`; only the in-process/pixel drivers advertise `screenshot`.
 */
export const VERB_CAPABILITY: Record<StepVerb, StepCapReq> = {
  join: null,
  leave: null,
  chat: "chat",
  command: "command",
  waitForChat: "chat",
  assertChat: "chat",
  waitForScreen: ["containerGui", "clientScreens"],
  listElements: ["containerGui", "clientScreens"],
  click: ["containerGui", "clientScreens"],
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
  /**
   * Directory the `screenshot` verb persists captured PNGs into (the same
   * per-test artifacts dir the failure bundle uses). Absent → screenshots are
   * captured over the wire but not written to disk (back-compat for callers that
   * don't supply an output dir, e.g. unit tests that only assert `ok`).
   */
  artifactsDir?: string;
  /**
   * Optional baseline dir for the informational, NON-GATING screenshot diff.
   * When set, the `screenshot` verb diffs against `<baselineDir>/<key>.png`
   * (seeding it on first run). Never affects pass/fail (ROADMAP §5.4 / M4).
   */
  baselineDir?: string;
  /**
   * Sink for artifacts a step produces (e.g. the `screenshot` verb's PNG +
   * baseline diff), so the Runner can attach them to the `StepResult` and the
   * test's `artifacts[]` without the executor's `Promise<string>` contract
   * changing. Called zero-or-more times per step.
   */
  onArtifact?: (artifact: ScreenshotArtifact) => void;
  /**
   * Set by the Runner when the session is driven by the cost-1 `server` driver:
   * the primary connection is a server-truth agent, not a player surface, so
   * `join`/`leave` are no-ops (the agent registers no `world.join`/`world.leave`).
   * Lets a server-truth-only test (e.g. `mod.loaded` on a Forge/NeoForge server,
   * where no bot can join) include a `join` step without erroring.
   */
  serverTruthOnly?: boolean;
}

/**
 * Resolves the connection a verb's MCTP calls go to, keyed by the capability
 * requirement the verb implies (`VERB_CAPABILITY[verb]`). `null` → the
 * primary/driver session; a single key or an anyOf group → the first connection
 * advertising it. A `SessionGroup` satisfies this contract directly via `route`.
 */
export type SessionRouter = (cap: StepCapReq) => Session | undefined;

/** A single-connection router (M2 back-compat / unit tests): every verb → one session. */
export function singleSessionRouter(session: Session): SessionRouter {
  return () => session;
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

/** The `expect` predicate operators (PROTOCOL.md §7.5). */
const PREDICATE_KEYS = new Set(["equals", "notEquals", "contains", "gt", "gte", "lt", "lte", "exists"]);

/**
 * Build the wire `expect` object. A value already in predicate shape (`{ gt: 3 }`) passes through;
 * the common `expect: true` shorthand (a bare scalar) becomes `{ equals: <value> }`. This keeps the
 * canonical shorthand while letting authors reach the other seven predicates.
 */
function toExpect(raw: unknown): Record<string, unknown> {
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const keys = Object.keys(raw as Record<string, unknown>);
    if (keys.length > 0 && keys.every((k) => PREDICATE_KEYS.has(k))) {
      return raw as Record<string, unknown>;
    }
  }
  return { equals: raw };
}

/**
 * Execute one step, returning a human-readable detail. The verb's MCTP calls are
 * routed to the connection that advertises its capability (`VERB_CAPABILITY`),
 * so GUI verbs hit the driver and truth/fixture/player verbs hit the server
 * agent. Throws (an `MctpRpcError` or assertion `Error`) to mark the step — and
 * the test — failed.
 */
export async function executeStep(
  router: SessionRouter,
  step: { verb: StepVerb; args: unknown },
  ctx: ExecContext,
): Promise<string> {
  const session = router(VERB_CAPABILITY[step.verb]);
  if (!session) {
    // Defensive: the Runner skips a step before calling us when no connection
    // advertises its capability, so this only fires on a routing misconfiguration.
    throw new Error(`no connection routes verb '${step.verb}'`);
  }
  const a = asObject(step.args);
  switch (step.verb) {
    case "join": {
      // Server-truth-only session (cost-1 `server` driver): no player surface to
      // join — the agent answers truth/fixture/state directly. No-op honestly.
      if (ctx.serverTruthOnly) return "server-truth session (no world join)";
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
      if (ctx.serverTruthOnly) return "server-truth session (no world leave)";
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
      // Build the MCTP params from the authored args (region / maxWidth / maxHeight);
      // `format`/`return` are defaulted by captureScreenshot.
      const params: Record<string, unknown> = {};
      if (typeof a["region"] === "string") params["region"] = a["region"];
      if (typeof a["maxWidth"] === "number") params["maxWidth"] = a["maxWidth"];
      if (typeof a["maxHeight"] === "number") params["maxHeight"] = a["maxHeight"];
      // A `name` arg labels the capture (filename + baseline key); else use the step verb.
      const slot = typeof a["name"] === "string" && a["name"] ? String(a["name"]) : "step";
      if (!ctx.artifactsDir) {
        // No output dir wired (e.g. a unit harness): still call the primitive so the
        // capability/round-trip is exercised, but there's nowhere to persist the PNG.
        await session.call("screen.screenshot", params);
        return "captured screenshot (not persisted: no artifacts dir)";
      }
      const artifact = await captureScreenshot(session, {
        artifactsDir: ctx.artifactsDir,
        slot,
        ...(Object.keys(params).length ? { params } : {}),
        ...(ctx.baselineDir ? { baselineDir: ctx.baselineDir, baselineKey: slot } : {}),
      });
      if (!artifact) return "captured screenshot (no inline image returned)";
      ctx.onArtifact?.(artifact);
      const b = artifact.baseline;
      const diffNote = b
        ? b.compared
          ? b.unsupported
            ? ` — baseline diff unsupported (${b.unsupported})`
            : ` — baseline diff ${(b.ratio! * 100).toFixed(2)}% (${b.diffPixels}/${b.totalPixels}px)`
          : " — baseline seeded"
        : "";
      return `screenshot → ${artifact.path}${diffNote}`;
    }
    case "getBlock": {
      const result = await session.call<{ block?: { type?: string } }>("truth.getWorldBlock", {
        world: a["world"],
        x: a["x"],
        y: a["y"],
        z: a["z"],
      });
      const got = result.block?.type ?? null;
      // With `expect`, this is a real world-state assertion: FAIL unless the agent's authoritative
      // block read matches (case-insensitive — agents emit lowercase `namespace:path`). Without it,
      // it stays a bare read that still exercises the full server-side block-read path (and fails on
      // any agent error, e.g. WORLD_NOT_READY / an unresolved mapping).
      if (a["expect"] !== undefined) {
        const want = String(a["expect"]);
        if (got === null || got.toLowerCase() !== want.toLowerCase()) {
          throw new Error(
            `block assertion failed at ${a["x"]},${a["y"]},${a["z"]}: expected ${want}, got ${got ?? "?"}`,
          );
        }
        return `block ${a["x"]},${a["y"]},${a["z"]} = ${got} (expected ${want})`;
      }
      return `block: ${got ?? "?"}`;
    }
    case "getEntities": {
      const result = await session.call<{ count?: number }>("truth.getEntities", a);
      return `${result.count ?? 0} entit(ies)`;
    }
    case "assertPluginState": {
      // `expect` is REQUIRED to produce a verdict: without it the agent returns `matched:null`
      // and the step would pass regardless of the actual state (a false green). Fail loudly instead.
      if (a["expect"] === undefined) {
        throw new Error(`assertPluginState '${String(a["query"] ?? "")}' requires 'expect' to produce a verdict`);
      }
      const result = await session.call<PluginStateResult>("truth.assertPluginState", {
        ...(a["plugin"] ? { plugin: a["plugin"] } : {}),
        query: String(a["query"] ?? ""),
        ...(a["args"] ? { args: a["args"] } : {}),
        expect: toExpect(a["expect"]),
      });
      // Pass only on an explicit positive verdict; `matched` false/null/absent is a failure.
      if (result.matched !== true) {
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
