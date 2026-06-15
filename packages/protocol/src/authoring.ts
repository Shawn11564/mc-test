/**
 * The write-once authoring model: `Test` → `Step[]` → `Target`.
 *
 * Both authoring surfaces (YAML `*.mctest.yml` and the fluent API) compile to
 * these shared types, which the runner maps onto MCTP calls (the step→MCTP
 * mapping table is ROADMAP §3.4). Step verbs are the canonical set from
 * ROADMAP §10; this file is the source of truth only for the TS shape, not the
 * authoring grammar (owned by the runner in M2).
 *
 * These are plain TypeScript types (not wire schemas) — they never cross MCTP.
 */
import type { Loader, RequiredCapabilities } from "./capabilities.js";
import type { Selector } from "./selectors.js";
import type { Vec3 } from "./common.js";
import type { ChatChannel, ScreenKind } from "./mctp.js";

/** The driver kinds a target may select (cost order: server < headless < inprocess < pixel). */
export type DriverId = "server" | "headless" | "inprocess" | "pixel";

/** A display backend for rendered-client targets. */
export type DisplayBackend = "xvfb" | "desktop";

/** A matrix target — one `(loader × mc × driver × world × plugins/mods)` cell. */
export interface Target {
  id: string;
  loader?: Loader;
  /** Minecraft version, e.g. `"1.20.4"`. */
  mc?: string;
  driver?: DriverId;
  /** Route the headless driver through ViaVersion/ViaProxy. */
  via?: boolean;
  plugins?: string[];
  mods?: string[];
  agents?: string[];
  display?: DisplayBackend;
  worldSnapshot?: string;
  world?: string;
  "online-mode"?: boolean;
}

// --- Steps (one verb key per step; ROADMAP §3.4 / §10) ---------------------

export interface JoinStep {
  join: {
    host: string;
    port?: number;
    username?: string;
    auth?: "offline" | "microsoft";
    world?: string;
  };
}

export interface LeaveStep {
  leave?: { reason?: string } | null;
}

export interface ChatStep {
  chat: { message: string } | string;
}

/** Runs a slash command (no leading `/`), e.g. `command: "or"`. */
export interface CommandStep {
  command: string;
}

export interface WaitForChatStep {
  waitForChat: { contains?: string; regex?: string; channel?: ChatChannel; timeoutMs?: number };
}

export interface AssertChatStep {
  assertChat: { contains?: string; regex?: string; channel?: ChatChannel; timeoutMs?: number };
}

export interface WaitForScreenStep {
  waitForScreen: {
    titleContains?: string;
    screenId?: string;
    screenIdPrefix?: string;
    kind?: ScreenKind;
    change?: "opened" | "closed" | "replaced";
    timeoutMs?: number;
  };
}

export interface ListElementsStep {
  listElements: { selector?: Selector };
}

/** Clicks a semantically-selected element (string shorthand expands to `{ label }`). */
export interface ClickStep {
  click: Selector | string;
}

export interface TypeStep {
  type: { text: string; selector?: Selector; clear?: boolean; submit?: boolean };
}

export interface PressStep {
  press: { key: string; action?: "press" | "down" | "up"; modifiers?: string[] };
}

export interface ScreenshotStep {
  screenshot: { name?: string; region?: "screen" | "gui"; maxWidth?: number; maxHeight?: number };
}

export interface GetBlockStep {
  getBlock: { world?: string; x: number; y: number; z: number };
}

export interface GetEntitiesStep {
  getEntities: { world?: string; center?: Vec3; radius?: number; type?: string };
}

export interface AssertPluginStateStep {
  assertPluginState: {
    /** Per-step capability gate; missing → the step honestly skips. */
    requires?: RequiredCapabilities;
    plugin?: string;
    query: string;
    args?: Record<string, unknown>;
    expect?: unknown;
  };
}

export interface FixtureStep {
  fixture: {
    /** Fixture recipe name (`fixture` on the wire; `name` accepted as an alias). */
    name?: string;
    fixture?: string;
    args?: Record<string, unknown>;
    /** When `true`, this is a `fixture.reset` rather than a `fixture.set`. */
    reset?: boolean;
    snapshot?: string;
  };
}

export interface SpawnFakePlayerStep {
  spawnFakePlayer: { name?: string; username?: string; at?: Vec3; gameMode?: string };
}

/** A single authored step (exactly one verb key). */
export type Step =
  | JoinStep
  | LeaveStep
  | ChatStep
  | CommandStep
  | WaitForChatStep
  | AssertChatStep
  | WaitForScreenStep
  | ListElementsStep
  | ClickStep
  | TypeStep
  | PressStep
  | ScreenshotStep
  | GetBlockStep
  | GetEntitiesStep
  | AssertPluginStateStep
  | FixtureStep
  | SpawnFakePlayerStep;

/** The canonical step verbs (ROADMAP §10), for validation/loaders. */
export const STEP_VERBS = [
  "join",
  "leave",
  "chat",
  "command",
  "waitForChat",
  "assertChat",
  "waitForScreen",
  "listElements",
  "click",
  "type",
  "press",
  "screenshot",
  "getBlock",
  "getEntities",
  "assertPluginState",
  "fixture",
  "spawnFakePlayer",
] as const;

export type StepVerb = (typeof STEP_VERBS)[number];

/** A test authored once and run across the matrix. */
export interface Test {
  name: string;
  /** Capabilities the test cannot run without (missing → skip with reason). */
  requires?: RequiredCapabilities;
  /** Capabilities used if granted, never a cause for skip. */
  optional?: RequiredCapabilities;
  /** Target guard evaluated before negotiation. */
  appliesTo?: { loaders?: Loader[]; mc?: string };
  /** A target id reference or an inline target. */
  target?: string | Target;
  /** Optional hard driver pin. */
  driver?: DriverId;
  steps: Step[];
}
