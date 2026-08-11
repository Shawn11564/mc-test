/**
 * Phase-2 step 3: the TIME verbs (`waitForBlock` / `waitForPluginState`) and
 * SIGN-EDITOR typing.
 *
 * The time verbs exist because real SUTs write state a few ticks after the action
 * that triggered it. Before them a test had two bad options: assert immediately and
 * flake, or sleep and hope. They reuse the click-retry wrapper verbatim, so the
 * waiting stays in the runner and the agent keeps answering instantaneously
 * (Prime Directive 2).
 *
 * The honesty properties under test:
 *   - a wait that never comes true FAILS, with the last real mismatch as the reason
 *     (never a bare "timed out"), and it does not silently pass on the first read;
 *   - a wait with no condition is rejected outright rather than passing vacuously;
 *   - a malformed test (`waitForPluginState` with no `expect`) fails IMMEDIATELY
 *     instead of burning the whole budget on a question with no verdict;
 *   - sign typing reports `typedVia: screenCharTyped`, so a report can never hide
 *     that the text went in through the fallback rather than a real text field.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  Runner,
  DriverRegistry,
  UnsatisfiedError,
  withSelectorWaits,
  parseStepDocument,
  test as authorTest,
  type DriverDescriptor,
  type NormalizedTest,
  type TestResult,
} from "../src/index.js";
import { MockAgent } from "./mockAgent.js";
import { MockClientAgent } from "./mockClientAgent.js";

const META = { target: "mock-paper", loader: "paper", mc: "1.20.4" };
const EXEC = { host: "127.0.0.1", port: 25565, defaultUsername: "Tester" };

const TRUTH_CAPS = { chat: true, command: true, worldTruth: true, pluginState: true } as const;
const CLIENT_CAPS = { chat: true, command: true, clientScreens: true, typeText: true, pressKey: true } as const;

const stopped: { stop: () => Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(stopped.splice(0).map((a) => a.stop()));
});

function descriptorFor(url: string, advertised: Record<string, unknown>, id = "headless"): DriverDescriptor {
  return {
    id,
    kind: id === "inprocess" ? "clientMod" : "headlessBot",
    cost: 2,
    advertised: advertised as DriverDescriptor["advertised"],
    create: async () => ({ url, stop: async () => {} }),
  };
}

async function run(
  test: NormalizedTest,
  url: string,
  advertised: Record<string, unknown>,
  id = "headless",
): Promise<TestResult> {
  const registry = new DriverRegistry();
  const descriptor = descriptorFor(url, advertised, id);
  registry.register(descriptor);
  return new Runner(registry).runTest(test, descriptor, url, EXEC, META);
}

function failureOf(result: TestResult): string {
  return result.steps.find((s) => s.outcome === "failed")?.error?.message ?? "";
}

// ---------------------------------------------------------------------------
// The retry wrapper itself
// ---------------------------------------------------------------------------

describe("withSelectorWaits + UnsatisfiedError", () => {
  it("retries an UnsatisfiedError only when asked to", async () => {
    let calls = 0;
    const flaky = async (): Promise<string> => {
      calls++;
      if (calls < 3) throw new UnsatisfiedError(`not yet (attempt ${calls})`);
      return "settled";
    };
    await expect(
      withSelectorWaits(flaky, { intervalMs: 1, timeoutMs: 500, retryUnsatisfied: true }),
    ).resolves.toBe("settled");
    expect(calls).toBe(3);

    // Without the flag the very first "not yet" is fatal — the click verb's behavior is unchanged.
    calls = 0;
    await expect(withSelectorWaits(flaky, { intervalMs: 1, timeoutMs: 500 })).rejects.toThrow("not yet");
    expect(calls).toBe(1);
  });

  it("rethrows the LAST mismatch on timeout, not a generic deadline error", async () => {
    const never = async (): Promise<never> => {
      throw new UnsatisfiedError("facing: expected \"east\", got \"north\"");
    };
    await expect(
      withSelectorWaits(never, { intervalMs: 1, timeoutMs: 30, retryUnsatisfied: true }),
    ).rejects.toThrow('facing: expected "east", got "north"');
  });
});

// ---------------------------------------------------------------------------
// waitForBlock
// ---------------------------------------------------------------------------

describe("waitForBlock", () => {
  it("passes on a DEFERRED block — state that appears a few polls late", async () => {
    const agent = new MockAgent({
      capabilities: ["chat", "command", "worldTruth"],
      blocks: { "3,-60,0": "minecraft:air" },
    });
    stopped.push(agent);
    const { url } = await agent.start();

    // The SUT "writes" the sign ~120ms after the action — the exact shape a plugin's
    // scheduled task has, and precisely what an assert-once verb would flake on.
    setTimeout(() => agent.setBlock({ x: 3, y: -60, z: 0 }, "minecraft:oak_wall_sign", { facing: "east" }), 120);

    const test = authorTest("deferred-sign")
      .requires({ worldTruth: true })
      .waitForBlock({
        x: 3,
        y: -60,
        z: 0,
        expect: "minecraft:oak_wall_sign",
        expectProperties: { facing: "east" },
        timeoutMs: 3000,
        intervalMs: 25,
      })
      .build();
    const result = await run(test, url, TRUTH_CAPS);
    expect(result.outcome, JSON.stringify(result.steps, null, 2)).toBe("passed");
    expect(result.steps[0]?.detail).toContain("facing=east ✓");
    expect(result.steps[0]?.detail).toContain("within 3000ms");
  });

  it("an assert-once getBlock on the SAME deferred state goes red (why the verb exists)", async () => {
    const agent = new MockAgent({
      capabilities: ["chat", "command", "worldTruth"],
      blocks: { "3,-60,0": "minecraft:air" },
    });
    stopped.push(agent);
    const { url } = await agent.start();
    setTimeout(() => agent.setBlock({ x: 3, y: -60, z: 0 }, "minecraft:oak_wall_sign"), 120);

    const test = authorTest("immediate-assert")
      .requires({ worldTruth: true })
      .getBlock({ x: 3, y: -60, z: 0, expect: "minecraft:oak_wall_sign" })
      .build();
    const result = await run(test, url, TRUTH_CAPS);
    expect(result.outcome).toBe("failed");
    expect(failureOf(result)).toContain("expected minecraft:oak_wall_sign, got minecraft:air");
  });

  it("FAILS on timeout with the real mismatch, never a silent pass", async () => {
    const agent = new MockAgent({
      capabilities: ["chat", "command", "worldTruth"],
      blocks: { "3,-60,0": "minecraft:oak_wall_sign" },
      blockProperties: { "3,-60,0": { facing: "north" } },
    });
    stopped.push(agent);
    const { url } = await agent.start();
    const test = authorTest("never-faces-east")
      .requires({ worldTruth: true })
      .waitForBlock({ x: 3, y: -60, z: 0, expectProperties: { facing: "east" }, timeoutMs: 120, intervalMs: 20 })
      .build();
    const result = await run(test, url, TRUTH_CAPS);
    expect(result.outcome).toBe("failed");
    expect(failureOf(result)).toContain('facing: expected "east", got "north"');
  });

  it("refuses a wait with NOTHING to wait for (a condition-free wait is not a test)", async () => {
    const agent = new MockAgent({ capabilities: ["chat", "command", "worldTruth"], blocks: {} });
    stopped.push(agent);
    const { url } = await agent.start();
    const test = authorTest("vacuous-wait")
      .requires({ worldTruth: true })
      .waitForBlock({ x: 0, y: 0, z: 0, timeoutMs: 100 })
      .build();
    const result = await run(test, url, TRUTH_CAPS);
    expect(result.outcome).toBe("failed");
    expect(failureOf(result)).toContain("requires at least one of");
  });

  it("honestly SKIPS without a worldTruth surface, exactly like getBlock", async () => {
    const agent = new MockAgent({ capabilities: ["chat", "command"], blocks: {} });
    stopped.push(agent);
    const { url } = await agent.start();
    const test = authorTest("no-truth")
      .waitForBlock({ x: 0, y: 0, z: 0, expect: "minecraft:stone" })
      .build();
    const result = await run(test, url, { chat: true, command: true });
    expect(result.steps[0]?.outcome).toBe("skipped");
    expect(result.steps[0]?.skip?.unmet).toEqual(["worldTruth"]);
  });
});

// ---------------------------------------------------------------------------
// waitForPluginState
// ---------------------------------------------------------------------------

describe("waitForPluginState", () => {
  it("passes once the plugin state flips", async () => {
    const agent = new MockAgent({
      capabilities: ["chat", "command", "pluginState"],
      listEntries: ["TestRegion"],
    });
    stopped.push(agent);
    const { url } = await agent.start();
    // The region only exists after a delay — a shop/region registering asynchronously.
    setTimeout(() => agent.setPluginState("regions.exists", true), 120);

    const test = authorTest("deferred-region")
      .requires({ pluginState: true })
      .waitForPluginState({ query: "regions.exists", expect: true, timeoutMs: 3000, intervalMs: 25 })
      .build();
    const result = await run(test, url, TRUTH_CAPS);
    expect(result.outcome, JSON.stringify(result.steps, null, 2)).toBe("passed");
    expect(result.steps[0]?.detail).toContain("regions.exists = true");
  });

  it("FAILS on timeout naming the value it kept seeing", async () => {
    const agent = new MockAgent({ capabilities: ["chat", "command", "pluginState"] });
    stopped.push(agent);
    const { url } = await agent.start();
    const test = authorTest("never-true")
      .requires({ pluginState: true })
      .waitForPluginState({ query: "regions.exists", expect: true, timeoutMs: 120, intervalMs: 20 })
      .build();
    const result = await run(test, url, TRUTH_CAPS);
    expect(result.outcome).toBe("failed");
    expect(failureOf(result)).toContain("pluginState assertion failed: regions.exists");
  });

  it("a missing `expect` fails IMMEDIATELY — a malformed test is not a slow one", async () => {
    const agent = new MockAgent({ capabilities: ["chat", "command", "pluginState"] });
    stopped.push(agent);
    const { url } = await agent.start();
    const test = authorTest("no-predicate")
      .requires({ pluginState: true })
      .waitForPluginState({ query: "regions.exists", timeoutMs: 5000 })
      .build();
    const started = Date.now();
    const result = await run(test, url, TRUTH_CAPS);
    expect(result.outcome).toBe("failed");
    expect(failureOf(result)).toContain("requires 'expect' to produce a verdict");
    // It must not have burned the 5s budget retrying a question with no verdict.
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

// ---------------------------------------------------------------------------
// Sign-editor typing (the client-side half)
// ---------------------------------------------------------------------------

describe("sign-editor typing", () => {
  it("types onto a sign screen and reports the charTyped fallback path", async () => {
    const agent = new MockClientAgent();
    stopped.push(agent);
    const { url } = await agent.start();
    const test = authorTest("sign-typing")
      .requires({ clientScreens: true, typeText: true })
      .join({ host: "localhost", port: 25565 })
      .command("editsign")
      .waitForScreen({ titleContains: "Edit Sign" })
      .type({ text: "ChestShop", clear: true, submit: true })
      .build();
    const result = await run(test, url, CLIENT_CAPS, "inprocess");
    expect(result.outcome, JSON.stringify(result.steps, null, 2)).toBe("passed");
    // The text really reached the sign — not just "the call returned ok".
    expect(agent.signContents).toBe("ChestShop");
    // …and the step reports HOW it got there, so the fallback is never invisible.
    expect(result.steps.find((s) => s.verb === "type")?.detail).toContain("screenCharTyped");
  });

  it("a normal screen still reports the real text-field path", async () => {
    const agent = new MockClientAgent();
    stopped.push(agent);
    const { url } = await agent.start();
    const test = authorTest("field-typing")
      .requires({ clientScreens: true, typeText: true })
      .command("or")
      .type({ text: "TestRegion" })
      .build();
    const result = await run(test, url, CLIENT_CAPS, "inprocess");
    expect(result.outcome).toBe("passed");
    expect(result.steps.find((s) => s.verb === "type")?.detail).toContain("textField");
    expect(agent.signContents).toBeNull();
  });
});

describe("YAML authoring", () => {
  it("compiles the new verbs from YAML", () => {
    const doc = {
      name: "time-verbs",
      requires: { worldTruth: true },
      steps: [
        { waitForBlock: { x: 3, y: -60, z: 0, expect: "minecraft:oak_wall_sign", timeoutMs: 5000 } },
        { waitForPluginState: { requires: { pluginState: true }, query: "shop.exists", expect: true } },
      ],
    };
    const parsed = parseStepDocument(doc, "inline.mctest.yml");
    expect(parsed.steps.map((s) => s.verb)).toEqual(["waitForBlock", "waitForPluginState"]);
    // The nested per-step gate is lifted out of the args, as for every other verb.
    expect(parsed.steps[1]?.requires).toEqual({ pluginState: true });
  });
});
