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
import type { BlockPos, Vec3 } from "./common.js";
import type { BlockFace, ChatChannel, Hand, MoveControls, ScreenKind } from "./mctp.js";

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

/**
 * World-interaction verbs (cap `worldInteraction`). A test ACTS on the world as
 * the player: the placement/protection shape (`sneak`-click a face with an item
 * held) that GUI + chat verbs alone cannot express.
 */
export interface UseBlockStep {
  useBlock: {
    pos: BlockPos;
    face?: BlockFace;
    hand?: Hand;
    sneak?: boolean;
    cursor?: Vec3;
    /** Per-step capability gate; missing → the step honestly skips. */
    requires?: RequiredCapabilities;
  };
}

export interface AttackBlockStep {
  attackBlock: {
    pos: BlockPos;
    face?: BlockFace;
    /** Dig the block to completion rather than a single punch. */
    breakBlock?: boolean;
    requires?: RequiredCapabilities;
  };
}

export interface SetHeldItemStep {
  setHeldItem:
    | string
    | { item?: string; slot?: number; hand?: Hand; requires?: RequiredCapabilities };
}

export interface LookStep {
  look: {
    yaw?: number;
    pitch?: number;
    at?: Vec3;
    force?: boolean;
    requires?: RequiredCapabilities;
  };
}

export interface MoveStep {
  move: {
    controls?: MoveControls;
    durationMs?: number;
    stop?: boolean;
    requires?: RequiredCapabilities;
  };
}

export interface GetBlockStep {
  getBlock: {
    world?: string;
    x: number;
    y: number;
    z: number;
    /** Per-step capability gate; missing → the step honestly skips. */
    requires?: RequiredCapabilities;
    /**
     * Optional assertion: the expected block id (e.g. `minecraft:bedrock`). When set, the step
     * FAILS unless the agent's authoritative `truth.getWorldBlock` returns exactly this type — turning
     * the read into a real world-state assertion (vs. a bare read that only proves the call succeeded).
     */
    expect?: string;
    /**
     * Blockstate property assertions, e.g. `{ facing: "east" }`. Compared against
     * the agent's authoritative `block.properties` as a **subset**: every listed
     * key must match (values compared as strings, case-insensitively), unlisted
     * properties are ignored. A property the block does not have is a FAILURE, not
     * a skip — `facing` is how "the sign landed on the clicked face" is proven.
     */
    expectProperties?: Record<string, string | number | boolean>;
    /**
     * Block-entity assertions against `block.nbt`, as a subset (nested objects are
     * matched recursively; arrays must match element-for-element). A block with no
     * block entity FAILS this assertion rather than passing vacuously.
     */
    expectNbt?: Record<string, unknown>;
  };
}

/**
 * An item-identity assertion. `type`/`count` alone are NOT identity — a modded
 * item is a vanilla material plus data components — so `components` compares the
 * agent's canonical component view **exactly** and `componentsHash` compares the
 * digest. Use `componentsInclude` for the looser "carries at least this" check.
 */
export interface ItemExpectation {
  type?: string;
  count?: number;
  displayName?: string;
  /** EXACT deep equality against the item's whole component map. */
  components?: Record<string, unknown>;
  /** Subset match: every listed key/path must be present and equal. */
  componentsInclude?: Record<string, unknown>;
  /** Exact digest match — the cheapest "this item only equals itself" assertion. */
  componentsHash?: string;
  /** Assert the slot is empty. Mutually exclusive with the other keys. */
  empty?: boolean;
}

/**
 * Time verbs: the assert-*until* twins of `getBlock` / `assertPluginState`. Same
 * assertions, same capability, wrapped in the runner's retry loop — so a state a
 * SUT writes a few ticks later is testable without a sleep in the test and without
 * any waiting logic inside the agent (Prime Directive 2).
 */
export interface WaitForBlockStep {
  waitForBlock: {
    world?: string;
    x: number;
    y: number;
    z: number;
    requires?: RequiredCapabilities;
    /** At least one of these three is REQUIRED — a wait with no condition is not a test. */
    expect?: string;
    expectProperties?: Record<string, string | number | boolean>;
    expectNbt?: Record<string, unknown>;
    /** Total budget. Default 10000ms. */
    timeoutMs?: number;
    /** Re-read cadence. Default 250ms. */
    intervalMs?: number;
  };
}

export interface WaitForPluginStateStep {
  waitForPluginState: {
    requires?: RequiredCapabilities;
    plugin?: string;
    query: string;
    args?: Record<string, unknown>;
    /** REQUIRED — without a predicate there is no verdict to wait for. */
    expect?: unknown;
    timeoutMs?: number;
    intervalMs?: number;
  };
}

export interface GetContainerStep {
  getContainer: {
    world?: string;
    x: number;
    y: number;
    z: number;
    includeEmpty?: boolean;
    requires?: RequiredCapabilities;
    /** Expected container block id, e.g. `minecraft:chest`. */
    expect?: string;
    /** Expected number of OCCUPIED slots. */
    expectCount?: number;
    /** Per-slot assertions, keyed by slot index. */
    expectSlots?: Record<string, ItemExpectation>;
  };
}

export interface GetItemStep {
  getItem: {
    world?: string;
    x: number;
    y: number;
    z: number;
    slot: number;
    requires?: RequiredCapabilities;
    expect?: ItemExpectation;
  };
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
  | UseBlockStep
  | AttackBlockStep
  | SetHeldItemStep
  | LookStep
  | MoveStep
  | GetBlockStep
  | WaitForBlockStep
  | WaitForPluginStateStep
  | GetContainerStep
  | GetItemStep
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
  "useBlock",
  "attackBlock",
  "setHeldItem",
  "look",
  "move",
  "getBlock",
  "waitForBlock",
  "waitForPluginState",
  "getContainer",
  "getItem",
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
