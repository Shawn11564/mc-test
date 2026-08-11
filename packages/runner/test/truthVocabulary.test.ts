/**
 * The widened truth vocabulary (phase 2): `expectProperties` on blockstates,
 * block-entity NBT assertions, and `getContainer`/`getItem` with **component-exact**
 * item identity.
 *
 * The through-line of every test here is that an assertion must be able to FAIL.
 * A blockstate assertion that ignores `facing`, an NBT assertion that passes on a
 * block with no block entity, or an item assertion that compares only the material
 * would all be green on the wrong world — which is exactly the false-green class
 * this vocabulary exists to close.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  Runner,
  DriverRegistry,
  parseStepDocument,
  test as authorTest,
  matchItem,
  matchProperties,
  matchSubset,
  canonicalJson,
  type DriverDescriptor,
  type NormalizedTest,
  type TestResult,
} from "../src/index.js";
import { MockAgent, type MockAgentOptions } from "./mockAgent.js";

const TRUTH_CAPS = { chat: true, command: true, worldTruth: true, worldInteraction: true } as const;
const CAP_KEYS = ["chat", "command", "worldTruth", "worldInteraction"];

const META = { target: "mock-paper", loader: "paper", mc: "1.20.4" };
const EXEC = { host: "127.0.0.1", port: 25565, defaultUsername: "Tester" };

const CHEST = { x: 2, y: -60, z: 0 };
/** The wall sign placed against the chest's EAST face lands here, facing east. */
const SIGN = { x: 3, y: -60, z: 0 };

/** A distinctive "modded-ish" item: a vanilla material carrying custom components. */
const NAMED_SWORD = {
  type: "minecraft:diamond_sword",
  count: 1,
  displayName: "Excalibur",
  components: { "display-name": "Excalibur", "meta-type": "UNSPECIFIC", enchants: { SHARPNESS: 5 } },
};
/** The SAME material with no components — the control that must not compare equal. */
const PLAIN_SWORD = { type: "minecraft:diamond_sword", count: 1, components: {} };

const WORLD: MockAgentOptions = {
  capabilities: CAP_KEYS,
  blocks: {
    "2,-60,0": "minecraft:chest",
    "3,-60,0": "minecraft:oak_wall_sign",
    "0,-60,0": "minecraft:stone",
  },
  blockProperties: {
    "3,-60,0": { facing: "east", waterlogged: "false" },
    "2,-60,0": { facing: "north", type: "single" },
  },
  blockEntities: {
    "3,-60,0": {
      front_text: { messages: ["ChestShop", "64 B 1:2", "", ""], has_glowing_text: false },
      is_waxed: false,
    },
  },
  containers: { "2,-60,0": { "0": NAMED_SWORD, "1": PLAIN_SWORD } },
};

const agents: MockAgent[] = [];
afterEach(async () => {
  await Promise.all(agents.splice(0).map((a) => a.stop()));
});

async function startAgent(opts: MockAgentOptions = WORLD): Promise<string> {
  const agent = new MockAgent(opts);
  agents.push(agent);
  const { url } = await agent.start();
  return url;
}

function descriptorFor(url: string): DriverDescriptor {
  return {
    id: "headless",
    kind: "headlessBot",
    cost: 2,
    advertised: { ...TRUTH_CAPS },
    create: async () => ({ url, stop: async () => {} }),
  };
}

async function run(test: NormalizedTest, url: string): Promise<TestResult> {
  const registry = new DriverRegistry();
  const descriptor = descriptorFor(url);
  registry.register(descriptor);
  return new Runner(registry).runTest(test, descriptor, url, EXEC, META);
}

/** The failure message of the first failed step (for asserting WHY something went red). */
function failureOf(result: TestResult): string {
  return result.steps.find((s) => s.outcome === "failed")?.error?.message ?? "";
}

// ---------------------------------------------------------------------------
// Blockstate properties
// ---------------------------------------------------------------------------

describe("expectProperties on blockstates", () => {
  it("asserts facing=east on a placed wall sign", async () => {
    const url = await startAgent();
    const test = authorTest("sign-faces-east")
      .requires({ worldTruth: true })
      .getBlock({ ...SIGN, expect: "minecraft:oak_wall_sign", expectProperties: { facing: "east" } })
      .build();
    const result = await run(test, url);
    expect(result.outcome, JSON.stringify(result.steps, null, 2)).toBe("passed");
    expect(result.steps[0]?.detail).toContain("facing=east ✓");
  });

  it("goes RED when the sign faces the wrong way (the assertion can fail)", async () => {
    const url = await startAgent();
    const test = authorTest("sign-faces-west")
      .requires({ worldTruth: true })
      .getBlock({ ...SIGN, expectProperties: { facing: "west" } })
      .build();
    const result = await run(test, url);
    expect(result.outcome).toBe("failed");
    expect(failureOf(result)).toContain('facing: expected "west", got "east"');
  });

  it("goes RED when the property does not exist at all (never a vacuous pass)", async () => {
    const url = await startAgent();
    const test = authorTest("stone-has-no-facing")
      .requires({ worldTruth: true })
      .getBlock({ x: 0, y: -60, z: 0, expectProperties: { facing: "east" } })
      .build();
    const result = await run(test, url);
    expect(result.outcome).toBe("failed");
    expect(failureOf(result)).toContain("no such property");
  });

  it("is a SUBSET match — unlisted properties are ignored", async () => {
    const url = await startAgent();
    const test = authorTest("subset")
      .requires({ worldTruth: true })
      .getBlock({ ...SIGN, expectProperties: { facing: "east" } })
      .build();
    expect((await run(test, url)).outcome).toBe("passed");
  });

  it("compares stringly: waterlogged=false matches the string \"false\"", async () => {
    const url = await startAgent();
    const test = authorTest("stringly")
      .requires({ worldTruth: true })
      .getBlock({ ...SIGN, expectProperties: { waterlogged: false } })
      .build();
    expect((await run(test, url)).outcome).toBe("passed");
  });
});

// ---------------------------------------------------------------------------
// Block-entity NBT
// ---------------------------------------------------------------------------

describe("block-entity NBT", () => {
  it("asserts sign text through expectNbt", async () => {
    const url = await startAgent();
    const test = authorTest("sign-says-chestshop")
      .requires({ worldTruth: true })
      .getBlock({
        ...SIGN,
        expectNbt: { front_text: { messages: ["ChestShop", "64 B 1:2", "", ""] } },
      })
      .build();
    const result = await run(test, url);
    expect(result.outcome, JSON.stringify(result.steps, null, 2)).toBe("passed");
  });

  it("goes RED on the wrong line (an NBT list is ordered data, not a bag)", async () => {
    const url = await startAgent();
    const test = authorTest("wrong-line")
      .requires({ worldTruth: true })
      .getBlock({ ...SIGN, expectNbt: { front_text: { messages: ["ChestShop", "WRONG", "", ""] } } })
      .build();
    const result = await run(test, url);
    expect(result.outcome).toBe("failed");
    expect(failureOf(result)).toContain("front_text.messages[1]");
  });

  it("goes RED when the block has NO block entity (never a vacuous pass)", async () => {
    const url = await startAgent();
    const test = authorTest("stone-has-no-block-entity")
      .requires({ worldTruth: true })
      .getBlock({ x: 0, y: -60, z: 0, expectNbt: { front_text: { messages: ["anything"] } } })
      .build();
    const result = await run(test, url);
    expect(result.outcome).toBe("failed");
    expect(failureOf(result)).toContain("reported no block entity");
  });
});

// ---------------------------------------------------------------------------
// Container / item truth with component-exact identity
// ---------------------------------------------------------------------------

describe("getContainer / getItem with component-exact identity", () => {
  it("asserts a container slot's exact components", async () => {
    const url = await startAgent();
    const test = authorTest("chest-slot-components")
      .requires({ worldTruth: true })
      .getContainer({
        ...CHEST,
        expect: "minecraft:chest",
        expectCount: 2,
        expectSlots: {
          "0": {
            type: "minecraft:diamond_sword",
            count: 1,
            displayName: "Excalibur",
            components: NAMED_SWORD.components,
          },
          "1": { type: "minecraft:diamond_sword", components: {} },
        },
      })
      .build();
    const result = await run(test, url);
    expect(result.outcome, JSON.stringify(result.steps, null, 2)).toBe("passed");
    expect(result.steps[0]?.detail).toContain("2/27 occupied");
  });

  it("a same-material item with DIFFERENT components is not equal (Cobblemon rule)", async () => {
    const url = await startAgent();
    // Slot 1 holds a PLAIN diamond sword; asserting the named one's components must FAIL
    // even though the material and count match exactly.
    const test = authorTest("plain-is-not-named")
      .requires({ worldTruth: true })
      .getItem({
        ...CHEST,
        slot: 1,
        expect: { type: "minecraft:diamond_sword", count: 1, components: NAMED_SWORD.components },
      })
      .build();
    const result = await run(test, url);
    expect(result.outcome).toBe("failed");
    expect(failureOf(result)).toContain("components: expected exactly");
  });

  it("componentsHash identifies an item and differs between the two swords", async () => {
    const url = await startAgent();
    // First read both hashes, then assert slot 0 against its own hash and NOT slot 1's.
    const read = authorTest("read-hashes")
      .requires({ worldTruth: true })
      .getItem({ ...CHEST, slot: 0 })
      .getItem({ ...CHEST, slot: 1 })
      .build();
    const result = await run(read, url);
    expect(result.outcome).toBe("passed");
    const hashes = result.steps.map((s) => /#([0-9a-f]{12})/.exec(s.detail ?? "")?.[1]);
    expect(hashes[0]).toBeDefined();
    expect(hashes[1]).toBeDefined();
    expect(hashes[0]).not.toBe(hashes[1]);
  });

  it("componentsInclude is the deliberate LOOSER check (subset, not exact)", async () => {
    const url = await startAgent();
    const loose = authorTest("subset-components")
      .requires({ worldTruth: true })
      .getItem({ ...CHEST, slot: 0, expect: { componentsInclude: { enchants: { SHARPNESS: 5 } } } })
      .build();
    expect((await run(loose, url)).outcome).toBe("passed");

    const exact = authorTest("exact-components")
      .requires({ worldTruth: true })
      .getItem({ ...CHEST, slot: 0, expect: { components: { enchants: { SHARPNESS: 5 } } } })
      .build();
    // The SAME expectation as `components` fails, because the item carries more than that.
    expect((await run(exact, url)).outcome).toBe("failed");
  });

  it("an empty slot is an explicit empty, and asserting an item there FAILS", async () => {
    const url = await startAgent();
    const ok = authorTest("empty-slot")
      .requires({ worldTruth: true })
      .getItem({ ...CHEST, slot: 5, expect: { empty: true } })
      .build();
    expect((await run(ok, url)).outcome).toBe("passed");

    const bad = authorTest("expect-item-in-empty-slot")
      .requires({ worldTruth: true })
      .getItem({ ...CHEST, slot: 5, expect: { type: "minecraft:diamond_sword" } })
      .build();
    const result = await run(bad, url);
    expect(result.outcome).toBe("failed");
    expect(failureOf(result)).toContain("found an empty slot");
  });

  it("a non-container block is invalidParams, not an empty container", async () => {
    const url = await startAgent();
    const test = authorTest("stone-is-not-a-chest")
      .requires({ worldTruth: true })
      .getContainer({ x: 0, y: -60, z: 0, expectCount: 0 })
      .build();
    const result = await run(test, url);
    expect(result.outcome).toBe("failed");
    expect(failureOf(result)).toContain("not a container");
  });

  it("the truth verbs honestly SKIP on a driver without worldTruth", async () => {
    const url = await startAgent({ ...WORLD, capabilities: ["chat", "command"] });
    const test = authorTest("no-truth-agent")
      .getContainer({ ...CHEST, expectCount: 2 })
      .getItem({ ...CHEST, slot: 0, expect: { type: "minecraft:diamond_sword" } })
      .build();
    const registry = new DriverRegistry();
    const descriptor: DriverDescriptor = {
      id: "headless",
      kind: "headlessBot",
      cost: 2,
      advertised: { chat: true, command: true },
      create: async () => ({ url, stop: async () => {} }),
    };
    registry.register(descriptor);
    const result = await new Runner(registry).runTest(test, descriptor, url, EXEC, META);
    expect(result.outcome).toBe("passed"); // skips are not failures…
    for (const step of result.steps) {
      expect(step.outcome, step.verb).toBe("skipped");
      expect(step.skip?.unmet, step.verb).toEqual(["worldTruth"]);
    }
  });

  it("YAML authoring compiles the same steps as the fluent surface", () => {
    const doc = {
      name: "truth-yaml",
      requires: { worldTruth: true },
      steps: [
        { getBlock: { ...SIGN, expect: "minecraft:oak_wall_sign", expectProperties: { facing: "east" } } },
        { getContainer: { ...CHEST, expectCount: 2 } },
        { getItem: { ...CHEST, slot: 0, expect: { componentsHash: "sha256:deadbeef" } } },
      ],
    };
    const parsed = parseStepDocument(doc, "inline.mctest.yml");
    expect(parsed.steps.map((s) => s.verb)).toEqual(["getBlock", "getContainer", "getItem"]);
  });
});

// ---------------------------------------------------------------------------
// The pure matchers (fast, exhaustive edge cases)
// ---------------------------------------------------------------------------

describe("pure matchers", () => {
  it("matchProperties is a case-insensitive subset match", () => {
    expect(matchProperties({ facing: "EAST" }, { facing: "east", type: "single" })).toBeNull();
    expect(matchProperties({ facing: "east" }, { facing: "west" })).toContain("expected");
    expect(matchProperties({ facing: "east" }, undefined)).toContain("no such property");
    expect(matchProperties({}, undefined)).toBeNull();
  });

  it("matchSubset recurses objects but requires arrays to match element-for-element", () => {
    expect(matchSubset({ a: { b: 1 } }, { a: { b: 1, c: 2 }, d: 3 })).toBeNull();
    expect(matchSubset({ a: [1, 2] }, { a: [1, 2] })).toBeNull();
    expect(matchSubset({ a: [1] }, { a: [1, 2] })).toContain("expected 1 element(s), got 2");
    expect(matchSubset({ a: 1 }, {})).toContain("missing");
  });

  it("canonicalJson is key-order independent (so hashes are stable)", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it("matchItem refuses to pass a component assertion the agent cannot answer", () => {
    // `components` absent means "the agent cannot see components" — the one case where
    // passing would silently green-light every modded-item assertion.
    const blind = { type: "minecraft:stone", count: 1 };
    expect(matchItem({ components: {} }, blind)).toContain("cannot see");
    expect(matchItem({ componentsHash: "sha256:x" }, blind)).toContain("no component digest");
    // …while an agent reporting an explicitly EMPTY component map answers honestly.
    expect(matchItem({ components: {} }, { ...blind, components: {} })).toBeNull();
  });
});
