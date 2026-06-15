/**
 * The write-once fluent authoring API. Compiles to the SAME `NormalizedTest`
 * the YAML loader produces, so both surfaces run identically through the engine.
 */
import type { RequiredCapabilities, Selector } from "@mc-test/protocol";
import type { NormalizedTest, NormalizedStep } from "../model/Step.js";

export interface JoinArgs {
  host?: string;
  port?: number;
  username?: string;
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
  assertPluginState(args: AssertPluginStateArgs): this {
    const { requires, ...rest } = args;
    return this.push("assertPluginState", rest, requires);
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
