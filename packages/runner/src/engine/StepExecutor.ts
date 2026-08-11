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
import { withSelectorWaits, UnsatisfiedError } from "./SelectorWaits.js";
import {
  describeItem,
  matchItem,
  matchProperties,
  matchSubset,
  type ItemExpectation,
  type TruthItem,
} from "./TruthMatch.js";
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
  // World interaction: acting on the world AS the player. A driver that can only
  // read/observe (server-truth agent, pixel stub) does not advertise it, so these
  // steps honestly SKIP there rather than pretending to click.
  useBlock: "worldInteraction",
  attackBlock: "worldInteraction",
  setHeldItem: "worldInteraction",
  look: "worldInteraction",
  move: "worldInteraction",
  getBlock: "worldTruth",
  // Time verbs: the SAME capability as their assert-once twins — a wait is a
  // repeated read, so it can never be available where the read is not.
  waitForBlock: "worldTruth",
  waitForPluginState: "pluginState",
  getContainer: "worldTruth",
  getItem: "worldTruth",
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
interface TypeTextResult {
  typedVia?: "textField" | "screenCharTyped";
}
interface ContainerResult {
  container?: {
    type?: string;
    title?: string;
    size?: number;
    itemCount?: number;
    slots?: TruthItem[];
  };
}
interface ItemResult {
  slot?: number;
  item?: TruthItem | null;
}
interface UseBlockResult {
  block?: { type?: string };
}
interface AttackBlockResult {
  block?: { type?: string };
  broken?: boolean;
}
interface SetHeldItemResult {
  held?: { type?: string | null };
}
interface LookResult {
  yaw?: number;
  pitch?: number;
}
interface MoveResult {
  position?: { x: number; y: number; z: number };
  held?: string[];
}

/** Coerce an authored `pos` into integer block coordinates (or fail loudly). */
function blockPos(raw: unknown, verb: string): { x: number; y: number; z: number } {
  const p = asObject(raw);
  const x = Number(p["x"]);
  const y = Number(p["y"]);
  const z = Number(p["z"]);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    throw new Error(`${verb} requires pos: { x, y, z } (got ${JSON.stringify(raw)})`);
  }
  return { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) };
}

const describePos = (p: { x: number; y: number; z: number }): string => `${p.x},${p.y},${p.z}`;

const round1 = (n: number | undefined): string => (typeof n === "number" ? n.toFixed(1) : "?");

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

/** Builds the error a probe throws: a hard failure, or a "not yet" the wait loop retries. */
type ProbeFailure = (message: string) => Error;

/**
 * One authoritative block read + every assertion the author attached
 * (`expect` / `expectProperties` / `expectNbt`). Shared verbatim by `getBlock`
 * (assert once → `Error`) and `waitForBlock` (assert until → `UnsatisfiedError`),
 * so the two verbs can never drift into judging the same world differently.
 */
async function probeBlock(session: Session, a: Record<string, unknown>, fail: ProbeFailure): Promise<string> {
  const result = await session.call<{
    block?: { type?: string; properties?: Record<string, unknown>; nbt?: Record<string, unknown> };
  }>("truth.getWorldBlock", {
    world: a["world"],
    x: a["x"],
    y: a["y"],
    z: a["z"],
  });
  const got = result.block?.type ?? null;
  const where = `${a["x"]},${a["y"]},${a["z"]}`;
  const notes: string[] = [];
  // With `expect`, this is a real world-state assertion: FAIL unless the agent's authoritative
  // block read matches (case-insensitive — agents emit lowercase `namespace:path`). Without it,
  // it stays a bare read that still exercises the full server-side block-read path (and fails on
  // any agent error, e.g. WORLD_NOT_READY / an unresolved mapping).
  if (a["expect"] !== undefined) {
    const want = String(a["expect"]);
    if (got === null || got.toLowerCase() !== want.toLowerCase()) {
      throw fail(`block assertion failed at ${where}: expected ${want}, got ${got ?? "?"}`);
    }
    notes.push(`= ${got} (expected ${want})`);
  }
  // Blockstate properties (`facing`, `waterlogged`, …): a SUBSET match against the
  // agent's authoritative `properties`. This is how "the sign landed on the clicked
  // face" is proven — the type alone cannot distinguish north from east.
  if (a["expectProperties"] !== undefined) {
    const want = asObject(a["expectProperties"]);
    const problem = matchProperties(want, result.block?.properties);
    if (problem) {
      throw fail(`block property assertion failed at ${where} (${got ?? "?"}): ${problem}`);
    }
    notes.push(`properties ${Object.entries(want).map(([k, v]) => `${k}=${String(v)}`).join(" ")} ✓`);
  }
  // Block-entity data (sign text, container custom name, …). An `expectNbt` against a
  // block with NO block entity FAILS: passing vacuously there would green-light every
  // "the sign says X" assertion on a block that is not even a sign.
  if (a["expectNbt"] !== undefined) {
    const want = asObject(a["expectNbt"]);
    if (result.block?.nbt === undefined) {
      throw fail(
        `block-entity assertion failed at ${where} (${got ?? "?"}): the agent reported no block entity ` +
          `(this block has none, or the agent cannot read it)`,
      );
    }
    const problem = matchSubset(want, result.block.nbt);
    if (problem) {
      throw fail(`block-entity assertion failed at ${where} (${got ?? "?"}): ${problem}`);
    }
    notes.push(`nbt ${Object.keys(want).join(",")} ✓`);
  }
  if (notes.length) return `block ${where} ${notes.join(", ")}`;
  return `block: ${got ?? "?"}`;
}

/**
 * One authoritative plugin-state query + its verdict. Shared by `assertPluginState`
 * (assert once) and `waitForPluginState` (assert until).
 */
async function probePluginState(
  session: Session,
  a: Record<string, unknown>,
  fail: ProbeFailure,
): Promise<string> {
  // `expect` is REQUIRED to produce a verdict: without it the agent returns `matched:null`
  // and the step would pass regardless of the actual state (a false green). Fail loudly instead.
  // This is a MALFORMED TEST, not a "not yet" — so it is always a hard Error, never retried.
  if (a["expect"] === undefined) {
    throw new Error(`pluginState '${String(a["query"] ?? "")}' requires 'expect' to produce a verdict`);
  }
  const result = await session.call<PluginStateResult>("truth.assertPluginState", {
    ...(a["plugin"] ? { plugin: a["plugin"] } : {}),
    query: String(a["query"] ?? ""),
    ...(a["args"] ? { args: a["args"] } : {}),
    expect: toExpect(a["expect"]),
  });
  // Pass only on an explicit positive verdict; `matched` false/null/absent is a failure.
  if (result.matched !== true) {
    throw fail(`pluginState assertion failed: ${String(a["query"])} = ${JSON.stringify(result.value)}`);
  }
  return `pluginState ${String(a["query"])} = ${JSON.stringify(result.value)}`;
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
      const result = await session.call<TypeTextResult>("screen.typeText", {
        text: String(a["text"] ?? ""),
        ...(a["selector"] ? { selector: a["selector"] } : {}),
        ...(a["clear"] !== undefined ? { clear: a["clear"] } : {}),
        ...(a["submit"] !== undefined ? { submit: a["submit"] } : {}),
      });
      // Surface HOW the text went in. `screenCharTyped` means the agent fell back to
      // replaying characters on the screen itself (the sign editor has no text widget) —
      // a report must never hide that distinction, and older agents that report nothing
      // simply say "typed text" as before.
      return result.typedVia ? `typed text (via ${result.typedVia})` : "typed text";
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
    case "useBlock": {
      const pos = blockPos(a["pos"], "useBlock");
      const face = String(a["face"] ?? "up");
      const result = await session.call<UseBlockResult>("world.useBlock", {
        pos,
        face,
        ...(a["hand"] ? { hand: a["hand"] } : {}),
        ...(a["sneak"] !== undefined ? { sneak: a["sneak"] === true } : {}),
        ...(a["cursor"] ? { cursor: a["cursor"] } : {}),
      });
      const sneaking = a["sneak"] === true ? "sneak-" : "";
      return `${sneaking}used ${result.block?.type ?? "block"} at ${describePos(pos)} face ${face}`;
    }
    case "attackBlock": {
      const pos = blockPos(a["pos"], "attackBlock");
      const face = String(a["face"] ?? "up");
      const result = await session.call<AttackBlockResult>("world.attackBlock", {
        pos,
        face,
        ...(a["breakBlock"] !== undefined ? { breakBlock: a["breakBlock"] === true } : {}),
      });
      return `attacked ${result.block?.type ?? "block"} at ${describePos(pos)} face ${face}${
        result.broken ? " (broken)" : ""
      }`;
    }
    case "setHeldItem": {
      // String shorthand: `setHeldItem: minecraft:oak_sign`.
      const params =
        typeof step.args === "string"
          ? { item: step.args }
          : {
              ...(a["item"] !== undefined ? { item: String(a["item"]) } : {}),
              ...(typeof a["slot"] === "number" ? { slot: a["slot"] } : {}),
              ...(a["hand"] ? { hand: a["hand"] } : {}),
            };
      const result = await session.call<SetHeldItemResult>("world.setHeldItem", params);
      return `holding ${result.held?.type ?? "nothing"}`;
    }
    case "look": {
      const result = await session.call<LookResult>("world.look", {
        ...(typeof a["yaw"] === "number" ? { yaw: a["yaw"] } : {}),
        ...(typeof a["pitch"] === "number" ? { pitch: a["pitch"] } : {}),
        ...(a["at"] ? { at: a["at"] } : {}),
        ...(a["force"] !== undefined ? { force: a["force"] === true } : {}),
      });
      return `looking yaw=${round1(result.yaw)} pitch=${round1(result.pitch)}`;
    }
    case "move": {
      const result = await session.call<MoveResult>("world.move", {
        ...(a["controls"] ? { controls: a["controls"] } : {}),
        ...(typeof a["durationMs"] === "number" ? { durationMs: a["durationMs"] } : {}),
        ...(a["stop"] !== undefined ? { stop: a["stop"] === true } : {}),
      });
      const held = result.held?.length ? ` (holding ${result.held.join(",")})` : "";
      const p = result.position;
      return `moved${p ? ` → ${round1(p.x)},${round1(p.y)},${round1(p.z)}` : ""}${held}`;
    }
    case "getBlock": {
      // Assert ONCE: any mismatch is a failure right now.
      return probeBlock(session, a, (message) => new Error(message));
    }
    case "waitForBlock": {
      // Assert UNTIL: the exact same probe, wrapped in the exact same retry loop the
      // `click` verb uses. A mismatch becomes an UnsatisfiedError, which the wrapper
      // retries until the budget expires — then rethrows it, so a timeout still says
      // WHAT never became true instead of a bare deadline message. This is what makes
      // a deferred state (a plugin writing a block a tick or three later) testable
      // without sleeps in the test and without waiting logic inside the agent.
      const timeoutMs = (a["timeoutMs"] as number | undefined) ?? 10000;
      const intervalMs = (a["intervalMs"] as number | undefined) ?? 250;
      if (a["expect"] === undefined && a["expectProperties"] === undefined && a["expectNbt"] === undefined) {
        // A wait with nothing to wait FOR would return on the first read and read as
        // coverage; demand a condition rather than pass vacuously.
        throw new Error(
          "waitForBlock requires at least one of 'expect', 'expectProperties' or 'expectNbt' to have something to wait for",
        );
      }
      const detail = await withSelectorWaits(
        () => probeBlock(session, a, (message) => new UnsatisfiedError(message)),
        { timeoutMs, intervalMs, retryUnsatisfied: true },
      );
      return `${detail} (within ${timeoutMs}ms)`;
    }
    case "waitForPluginState": {
      const timeoutMs = (a["timeoutMs"] as number | undefined) ?? 10000;
      const intervalMs = (a["intervalMs"] as number | undefined) ?? 250;
      const detail = await withSelectorWaits(
        () => probePluginState(session, a, (message) => new UnsatisfiedError(message)),
        { timeoutMs, intervalMs, retryUnsatisfied: true },
      );
      return `${detail} (within ${timeoutMs}ms)`;
    }
    case "getContainer": {
      const result = await session.call<ContainerResult>("truth.getContainer", {
        ...(a["world"] ? { world: a["world"] } : {}),
        x: a["x"],
        y: a["y"],
        z: a["z"],
        ...(a["includeEmpty"] !== undefined ? { includeEmpty: a["includeEmpty"] === true } : {}),
      });
      const where = `${a["x"]},${a["y"]},${a["z"]}`;
      const container = result.container;
      if (!container) throw new Error(`no container reported at ${where}`);
      if (a["expect"] !== undefined) {
        const want = String(a["expect"]);
        if ((container.type ?? "").toLowerCase() !== want.toLowerCase()) {
          throw new Error(
            `container assertion failed at ${where}: expected ${want}, got ${container.type ?? "?"}`,
          );
        }
      }
      if (a["expectCount"] !== undefined) {
        const want = Number(a["expectCount"]);
        if (container.itemCount !== want) {
          throw new Error(
            `container assertion failed at ${where}: expected ${want} occupied slot(s), got ${container.itemCount ?? 0}` +
              ` [${(container.slots ?? []).map(describeItem).join(" | ")}]`,
          );
        }
      }
      const expectSlots = a["expectSlots"] !== undefined ? asObject(a["expectSlots"]) : undefined;
      if (expectSlots) {
        for (const [slotKey, rawExpect] of Object.entries(expectSlots)) {
          const slot = Number(slotKey);
          const item = (container.slots ?? []).find((s) => s.slot === slot) ?? null;
          const problem = matchItem(rawExpect as ItemExpectation, item);
          if (problem) {
            throw new Error(`container slot ${slot} at ${where}: ${problem}`);
          }
        }
      }
      const asserted = [
        ...(a["expect"] !== undefined ? [`type=${container.type}`] : []),
        ...(a["expectCount"] !== undefined ? [`count=${container.itemCount}`] : []),
        ...(expectSlots ? [`slots ${Object.keys(expectSlots).join(",")} ✓`] : []),
      ];
      return `container ${container.type ?? "?"} at ${where}: ${container.itemCount ?? 0}/${container.size ?? 0} occupied` +
        (asserted.length ? ` — ${asserted.join(", ")}` : "");
    }
    case "getItem": {
      const slot = Number(a["slot"]);
      if (!Number.isFinite(slot)) throw new Error("getItem requires a numeric 'slot'");
      const result = await session.call<ItemResult>("truth.getItem", {
        ...(a["world"] ? { world: a["world"] } : {}),
        x: a["x"],
        y: a["y"],
        z: a["z"],
        slot,
      });
      const where = `${a["x"]},${a["y"]},${a["z"]}`;
      const item = result.item ?? null;
      if (a["expect"] !== undefined) {
        const problem = matchItem(asObject(a["expect"]) as ItemExpectation, item);
        if (problem) throw new Error(`item assertion failed at ${where} slot ${slot}: ${problem}`);
        return `item ${where}[${slot}] = ${describeItem(item)} ✓`;
      }
      return `item ${where}[${slot}] = ${describeItem(item)}`;
    }
    case "getEntities": {
      const result = await session.call<{ count?: number }>("truth.getEntities", a);
      return `${result.count ?? 0} entit(ies)`;
    }
    case "assertPluginState":
      return probePluginState(session, a, (message) => new Error(message));
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
