/**
 * The write-once fluent authoring API. Compiles to the SAME `NormalizedTest`
 * the YAML loader produces, so both surfaces run identically through the engine.
 */
import type {
  BlockFace,
  BlockPos,
  Hand,
  ItemExpectation,
  MoveControls,
  RequiredCapabilities,
  Selector,
  Vec3,
} from "@mc-test/protocol";
import type { NormalizedTest, NormalizedStep } from "../model/Step.js";

export interface JoinArgs {
  host?: string;
  port?: number;
  username?: string;
}

export interface GetBlockArgs {
  requires?: RequiredCapabilities;
  world?: string;
  x: number;
  y: number;
  z: number;
  expect?: string;
  expectProperties?: Record<string, string | number | boolean>;
  expectNbt?: Record<string, unknown>;
}

export interface GetContainerArgs {
  requires?: RequiredCapabilities;
  world?: string;
  x: number;
  y: number;
  z: number;
  includeEmpty?: boolean;
  expect?: string;
  expectCount?: number;
  expectSlots?: Record<string, ItemExpectation>;
}

export interface GetItemArgs {
  requires?: RequiredCapabilities;
  world?: string;
  x: number;
  y: number;
  z: number;
  slot: number;
  expect?: ItemExpectation;
}

export interface AssertPluginStateArgs {
  requires?: RequiredCapabilities;
  plugin?: string;
  query: string;
  args?: Record<string, unknown>;
  expect?: unknown;
}

/** A fluent test builder. Call `.build()` (or pass to the runner) to materialize. */
export class FluentTest {
  private readonly _requires: RequiredCapabilities = {};
  private readonly _optional: RequiredCapabilities = {};
  private readonly _steps: NormalizedStep[] = [];

  constructor(readonly name: string) {}

  requires(caps: RequiredCapabilities): this {
    Object.assign(this._requires, caps);
    return this;
  }

  optional(caps: RequiredCapabilities): this {
    Object.assign(this._optional, caps);
    return this;
  }

  private push(verb: NormalizedStep["verb"], args: unknown, requires?: RequiredCapabilities): this {
    this._steps.push({ index: this._steps.length, verb, args, ...(requires ? { requires } : {}) });
    return this;
  }

  join(args: JoinArgs): this {
    return this.push("join", args);
  }
  leave(args: { reason?: string } = {}): this {
    return this.push("leave", args);
  }
  command(command: string): this {
    return this.push("command", command);
  }
  chat(message: string): this {
    return this.push("chat", message);
  }
  waitForScreen(args: { titleContains?: string; screenIdPrefix?: string; kind?: string; timeoutMs?: number }): this {
    return this.push("waitForScreen", args);
  }
  waitForChat(args: { contains?: string; regex?: string; timeoutMs?: number }): this {
    return this.push("waitForChat", args);
  }
  assertChat(args: { contains?: string; regex?: string; timeoutMs?: number }): this {
    return this.push("assertChat", args);
  }
  listElements(args: { selector?: Selector }): this {
    return this.push("listElements", args);
  }
  click(selector: Selector | string): this {
    return this.push("click", selector);
  }
  type(args: { text: string; selector?: Selector; clear?: boolean; submit?: boolean }): this {
    return this.push("type", args);
  }
  press(args: { key: string }): this {
    return this.push("press", args);
  }
  /** Right-click a block face (`sneak: true` = the placement/ChestShop shape). */
  useBlock(args: { pos: BlockPos; face?: BlockFace; hand?: Hand; sneak?: boolean; cursor?: Vec3 }): this {
    return this.push("useBlock", args);
  }
  /** Left-click a block face: a punch by default, a full dig with `breakBlock`. */
  attackBlock(args: { pos: BlockPos; face?: BlockFace; breakBlock?: boolean }): this {
    return this.push("attackBlock", args);
  }
  /** Select what the player holds — an item id, or `{ slot }` / `{ item, hand }`. */
  setHeldItem(args: string | { item?: string; slot?: number; hand?: Hand }): this {
    return this.push("setHeldItem", args);
  }
  look(args: { yaw?: number; pitch?: number; at?: Vec3; force?: boolean }): this {
    return this.push("look", args);
  }
  move(args: { controls?: MoveControls; durationMs?: number; stop?: boolean }): this {
    return this.push("move", args);
  }
  assertPluginState(args: AssertPluginStateArgs): this {
    const { requires, ...rest } = args;
    return this.push("assertPluginState", rest, requires);
  }
  /**
   * Authoritative block read + optional assertions: `expect` (block id),
   * `expectProperties` (blockstate subset, e.g. `{ facing: "east" }`), and
   * `expectNbt` (block-entity subset). Server-owned → gate with
   * `requires: { worldTruth: true }` so it honestly skips with no server agent.
   */
  getBlock(args: GetBlockArgs): this {
    const { requires, ...rest } = args;
    return this.push("getBlock", rest, requires);
  }
  /**
   * Poll the authoritative block read until the assertions hold (or the budget
   * expires). The assert-until twin of `getBlock` — for state a SUT writes a few
   * ticks after the action that triggered it.
   */
  waitForBlock(args: GetBlockArgs & { timeoutMs?: number; intervalMs?: number }): this {
    const { requires, ...rest } = args;
    return this.push("waitForBlock", rest, requires);
  }
  /** Poll a plugin-state query until its predicate holds. Assert-until twin of `assertPluginState`. */
  waitForPluginState(args: AssertPluginStateArgs & { timeoutMs?: number; intervalMs?: number }): this {
    const { requires, ...rest } = args;
    return this.push("waitForPluginState", rest, requires);
  }
  /** Read a container's contents and optionally assert per-slot item identity. */
  getContainer(args: GetContainerArgs): this {
    const { requires, ...rest } = args;
    return this.push("getContainer", rest, requires);
  }
  /** Read one container slot and assert its identity (`components` is EXACT). */
  getItem(args: GetItemArgs): this {
    const { requires, ...rest } = args;
    return this.push("getItem", rest, requires);
  }

  /** Materialize the normalized test (the engine's input). */
  build(): NormalizedTest {
    return {
      name: this.name,
      requires: { ...this._requires },
      ...(Object.keys(this._optional).length ? { optional: { ...this._optional } } : {}),
      steps: this._steps.map((s) => ({ ...s })),
    };
  }
}

/** Begin authoring a test in the fluent API. */
export function test(name: string): FluentTest {
  return new FluentTest(name);
}
