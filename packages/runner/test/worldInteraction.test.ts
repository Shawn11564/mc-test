/**
 * World-interaction verbs (phase 2): `useBlock` / `attackBlock` / `setHeldItem` /
 * `look` / `move`, gated on the `worldInteraction` capability.
 *
 * Proves, with no Minecraft boot: the step→MCTP mapping round-trips every verb,
 * the sneak-click placement shape (sign lands on the CLICKED face) is expressible
 * end to end, YAML ≡ fluent, and — the honesty half — a driver that does NOT
 * advertise `worldInteraction` (the pixel/OCR stub) skips instead of pretending.
 */
import { describe, it, expect, afterEach } from "vitest";
import { PIXEL_CAPABILITIES } from "@mc-test/driver-pixel/capabilities";
import { HEADLESS_CAPABILITIES } from "@mc-test/driver-headless/capabilities";
import {
  Runner,
  DriverRegistry,
  parseStepDocument,
  test as authorTest,
  type DriverDescriptor,
  type NormalizedTest,
  type TestResult,
} from "../src/index.js";
import { MockAgent, type MockAgentOptions } from "./mockAgent.js";

const INTERACTION_CAPS = {
  chat: true,
  command: true,
  containerGui: true,
  typeText: true,
  pressKey: true,
  worldInteraction: true,
  worldTruth: true,
} as const;

const CAP_KEYS = ["chat", "command", "containerGui", "typeText", "pressKey", "worldInteraction", "worldTruth"];

const META = { target: "mock-paper", loader: "paper", mc: "1.20.4" };
const EXEC = { host: "127.0.0.1", port: 25565, defaultUsername: "Tester" };

/** The chest the scenario clicks, and the neighbour the sign must land in. */
const CHEST = { x: 2, y: -60, z: 0 };
const NORTH_OF_CHEST = { x: 2, y: -60, z: -1 };

const agents: MockAgent[] = [];
afterEach(async () => {
  await Promise.all(agents.splice(0).map((a) => a.stop()));
});

async function startAgent(opts?: MockAgentOptions): Promise<string> {
  const agent = new MockAgent(opts);
  agents.push(agent);
  const { url } = await agent.start();
  return url;
}

function descriptorFor(url: string, advertised: Record<string, unknown>): DriverDescriptor {
  return {
    id: "headless",
    kind: "headlessBot",
    cost: 2,
    advertised: advertised as DriverDescriptor["advertised"],
    create: async () => ({ url, stop: async () => {} }),
  };
}

/** The canonical placement scenario: sneak-click the chest's north face holding a sign. */
function chestSignTest(): NormalizedTest {
  return authorTest("chest-face-sign-placement")
    .requires({ command: true, worldInteraction: true })
    .join({ host: "localhost", port: 25565, username: "Tester" })
    .setHeldItem("minecraft:oak_sign")
    .look({ at: { x: CHEST.x + 0.5, y: CHEST.y + 0.5, z: CHEST.z + 0.5 }, force: true })
    .useBlock({ pos: CHEST, face: "north", sneak: true })
    .build();
}

const WORLD = { [`${CHEST.x},${CHEST.y},${CHEST.z}`]: "minecraft:chest" };

function registryOf(...descriptors: DriverDescriptor[]): DriverRegistry {
  const registry = new DriverRegistry();
  for (const d of descriptors) registry.register(d);
  return registry;
}

const pixelDescriptor: DriverDescriptor = {
  id: "pixel",
  kind: "pixelOcr",
  cost: 4,
  advertised: PIXEL_CAPABILITIES,
  create: async () => ({ url: "", stop: async () => {} }),
};

const headlessDescriptor: DriverDescriptor = {
  id: "headless",
  kind: "headlessBot",
  cost: 2,
  advertised: HEADLESS_CAPABILITIES,
  create: async () => ({ url: "", stop: async () => {} }),
};

async function run(test: NormalizedTest, url: string, advertised: Record<string, unknown>): Promise<TestResult> {
  const descriptor = descriptorFor(url, advertised);
  return new Runner(registryOf(descriptor)).runTest(test, descriptor, url, EXEC, META);
}

describe("world-interaction verbs round-trip", () => {
  it("sneak-clicks a chest face and the sign lands on THAT face", async () => {
    const url = await startAgent({
      capabilities: CAP_KEYS,
      blocks: { ...WORLD },
      inventory: ["minecraft:oak_sign"],
    });
    const test = chestSignTest();
    // Assert the CONSEQUENCE via server truth, not just that the calls returned.
    test.steps.push(
      { index: test.steps.length, verb: "getBlock", args: { ...NORTH_OF_CHEST, expect: "minecraft:oak_sign" } },
      { index: test.steps.length + 1, verb: "getBlock", args: { ...CHEST, expect: "minecraft:chest" } },
    );
    const result = await run(test, url, INTERACTION_CAPS);
    expect(result.outcome, JSON.stringify(result.steps, null, 2)).toBe("passed");
    expect(result.steps.map((s) => s.verb)).toEqual([
      "join",
      "setHeldItem",
      "look",
      "useBlock",
      "getBlock",
      "getBlock",
    ]);
    expect(result.steps.find((s) => s.verb === "useBlock")?.detail).toContain("sneak-used minecraft:chest");
    expect(result.steps.find((s) => s.verb === "setHeldItem")?.detail).toBe("holding minecraft:oak_sign");
  });

  it("a NON-sneaking click opens the chest instead of placing (the control)", async () => {
    const url = await startAgent({
      capabilities: CAP_KEYS,
      blocks: { ...WORLD },
      inventory: ["minecraft:oak_sign"],
    });
    const test = authorTest("chest-face-no-sneak")
      .requires({ worldInteraction: true })
      .join({ host: "localhost", port: 25565 })
      .setHeldItem("minecraft:oak_sign")
      .useBlock({ pos: CHEST, face: "north" })
      .build();
    test.steps.push({
      index: test.steps.length,
      verb: "getBlock",
      args: { ...NORTH_OF_CHEST, expect: "minecraft:air" },
    });
    const result = await run(test, url, INTERACTION_CAPS);
    expect(result.outcome, JSON.stringify(result.steps, null, 2)).toBe("passed");
  });

  it("attackBlock, look and move round-trip and report their effect", async () => {
    const url = await startAgent({ capabilities: CAP_KEYS, blocks: { ...WORLD }, inventory: [] });
    const test = authorTest("interaction-surface")
      .requires({ worldInteraction: true })
      .join({ host: "localhost", port: 25565 })
      .look({ yaw: -90, pitch: 10 })
      .move({ controls: { forward: true, sprint: true }, durationMs: 10 })
      .move({ stop: true })
      .attackBlock({ pos: CHEST, face: "up", breakBlock: true })
      .build();
    test.steps.push({
      index: test.steps.length,
      verb: "getBlock",
      args: { ...CHEST, expect: "minecraft:air" },
    });
    const result = await run(test, url, INTERACTION_CAPS);
    expect(result.outcome, JSON.stringify(result.steps, null, 2)).toBe("passed");
    expect(result.steps.find((s) => s.verb === "look")?.detail).toBe("looking yaw=-90.0 pitch=10.0");
    expect(result.steps.find((s) => s.verb === "attackBlock")?.detail).toContain("(broken)");
  });

  it("setHeldItem FAILS loudly when the item is not in the inventory (no silent empty hand)", async () => {
    const url = await startAgent({ capabilities: CAP_KEYS, blocks: { ...WORLD }, inventory: [] });
    const test = authorTest("held-item-missing")
      .requires({ worldInteraction: true })
      .join({ host: "localhost", port: 25565 })
      .setHeldItem("minecraft:oak_sign")
      .build();
    const result = await run(test, url, INTERACTION_CAPS);
    expect(result.outcome).toBe("failed");
    const step = result.steps.find((s) => s.verb === "setHeldItem");
    expect(step?.outcome).toBe("failed");
    expect(step?.error?.reason).toBe("ELEMENT_NOT_FOUND");
  });

  it("useBlock on an unloaded position is WORLD_NOT_READY, never a false pass", async () => {
    const url = await startAgent({ capabilities: CAP_KEYS, blocks: {}, inventory: ["minecraft:oak_sign"] });
    const result = await run(chestSignTest(), url, INTERACTION_CAPS);
    expect(result.outcome).toBe("failed");
    expect(result.steps.find((s) => s.verb === "useBlock")?.error?.reason).toBe("WORLD_NOT_READY");
  });

  it("YAML authoring compiles to the same steps as the fluent surface", () => {
    const doc = {
      name: "chest-face-sign-placement",
      requires: { command: true, worldInteraction: true },
      steps: [
        { join: { host: "localhost", port: 25565, username: "Tester" } },
        { setHeldItem: "minecraft:oak_sign" },
        { look: { at: { x: 2.5, y: -59.5, z: 0.5 }, force: true } },
        { useBlock: { pos: CHEST, face: "north", sneak: true } },
      ],
    };
    const fromYaml = parseStepDocument(doc, "inline.mctest.yml");
    expect(fromYaml.steps.map((s) => s.verb)).toEqual(chestSignTest().steps.map((s) => s.verb));
    expect(fromYaml.requires).toEqual({ command: true, worldInteraction: true });
  });
});

describe("worldInteraction capability gating (honest skips)", () => {
  it("a driver without worldInteraction SKIPS the step, never runs it", async () => {
    const withoutInteraction = ["chat", "command", "containerGui", "typeText", "pressKey"];
    const url = await startAgent({ capabilities: withoutInteraction, blocks: { ...WORLD } });
    const test = authorTest("interaction-on-a-blind-driver")
      // NB: the TEST does not require it — only the verbs do, so the run reaches
      // the steps and each one skips individually (per-step honest skip).
      .join({ host: "localhost", port: 25565 })
      .setHeldItem("minecraft:oak_sign")
      .useBlock({ pos: CHEST, face: "north", sneak: true })
      .build();
    const advertised = {
      chat: true,
      command: true,
      containerGui: true,
      typeText: true,
      pressKey: true,
    };
    const result = await run(test, url, advertised);
    expect(result.outcome).toBe("passed"); // skips are not failures…
    for (const verb of ["setHeldItem", "useBlock"]) {
      const step = result.steps.find((s) => s.verb === verb);
      expect(step?.outcome, verb).toBe("skipped");
      expect(step?.skip?.reason, verb).toBe("NO_COMPATIBLE_DRIVER");
      expect(step?.skip?.unmet, verb).toEqual(["worldInteraction"]);
    }
    // …and the run reports them, so a reader can never mistake it for coverage.
    expect(result.systemOut).toContain("useBlock: SKIPPED NO_COMPATIBLE_DRIVER unmet=[worldInteraction]");
  });

  it("the pixel/OCR stub does not advertise worldInteraction → NO_COMPATIBLE_DRIVER", () => {
    expect(PIXEL_CAPABILITIES.worldInteraction).toBeUndefined();
    const selection = new Runner(registryOf(pixelDescriptor)).selectDriver(chestSignTest());
    expect(selection.descriptor).toBeUndefined();
    expect(selection.skip?.reason).toBe("NO_COMPATIBLE_DRIVER");
    expect(selection.skip?.unmet).toContain("worldInteraction");
  });

  it("the headless driver DOES advertise it, so the same test selects headless", () => {
    expect(HEADLESS_CAPABILITIES.worldInteraction).toBe(true);
    const selection = new Runner(registryOf(pixelDescriptor, headlessDescriptor)).selectDriver(
      chestSignTest(),
    );
    expect(selection.descriptor?.id).toBe("headless");
  });
});
