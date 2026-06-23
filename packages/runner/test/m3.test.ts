/**
 * M3 "testing the tester" layer — the multi-connection fan-out + co-selection,
 * proven with NO Minecraft boot (ROADMAP §7.2/§7.3). One `SessionGroup` fans
 * GUI/chat steps to the headless mock driver and truth/fixture/player steps to
 * the mock server agent; the test author writes no connection plumbing.
 *
 * The headline control is §7.3 truth/UI divergence: when the GUI/chat half
 * passes ("Region loaded") but real (mock) server state says the region does NOT
 * exist, the test goes RED on `assertPluginState` — proving we assert real state,
 * not just chat. Honest skips are preserved when no agent is co-connected (M2).
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  Runner,
  DriverRegistry,
  type AgentConn,
  type Capabilities,
  type DriverDescriptor,
  type NormalizedTest,
  type TestResult,
} from "../src/index.js";
import { MockAgent, type MockAgentOptions } from "./mockAgent.js";
import { MockServerAgent, type MockServerAgentOptions } from "./mockServerAgent.js";

const HEADLESS_CAPS: Capabilities = {
  chat: true,
  command: true,
  containerGui: true,
  typeText: true,
  pressKey: true,
};

const SERVER_AGENT_CAPS: Capabilities = {
  worldTruth: true,
  pluginState: true,
  fixtures: true,
  fakePlayers: true,
  chat: true,
  testIdTags: true,
};

const META = { target: "mock-paper", loader: "paper", mc: "1.20.4" };
const EXEC = { host: "127.0.0.1", port: 25565, defaultUsername: "Tester" };

// --- live mock lifecycle ----------------------------------------------------
const drivers: MockAgent[] = [];
const serverAgents: MockServerAgent[] = [];
afterEach(async () => {
  await Promise.all(drivers.splice(0).map((a) => a.stop()));
  await Promise.all(serverAgents.splice(0).map((a) => a.stop()));
});

async function startDriver(opts?: MockAgentOptions): Promise<string> {
  const agent = new MockAgent(opts);
  drivers.push(agent);
  return (await agent.start()).url;
}
async function startServerAgent(opts?: MockServerAgentOptions): Promise<{ url: string; agent: MockServerAgent }> {
  const agent = new MockServerAgent(opts);
  serverAgents.push(agent);
  const { url } = await agent.start();
  return { url, agent };
}

function mockDescriptor(url: string): DriverDescriptor {
  return {
    id: "headless",
    kind: "headlessBot",
    cost: 2,
    advertised: { ...HEADLESS_CAPS },
    create: async () => ({ url, stop: async () => {} }),
  };
}

function agentConn(url: string): AgentConn {
  return { url, advertised: { ...SERVER_AGENT_CAPS }, kind: "serverPlugin" };
}

function stepByVerb(result: TestResult, verb: string) {
  return result.steps.find((s) => s.verb === verb);
}

/** The canonical regions test (GUI/chat half + the server-truth half). */
function regionsTest(): NormalizedTest {
  return {
    name: "regions-open-testregion",
    requires: { command: true, containerGui: true },
    steps: [
      { index: 0, verb: "join", args: { username: "Tester" } },
      { index: 1, verb: "command", args: "or" },
      { index: 2, verb: "waitForScreen", args: { titleContains: "OpenRegions" } },
      { index: 3, verb: "click", args: { label: "Regions" } },
      { index: 4, verb: "click", args: { label: "TestRegion" } },
      { index: 5, verb: "assertChat", args: { contains: "Region loaded" } },
      {
        index: 6,
        verb: "assertPluginState",
        args: { plugin: "OpenRegions", query: "regions.exists", args: { name: "TestRegion" }, expect: true },
        requires: { pluginState: true },
      },
    ],
  };
}

describe("M3 multi-connection fan-out + co-selection", () => {
  it("1. multi-connection green: assertPluginState RUNS (not skipped) when the agent has the region", async () => {
    const driverUrl = await startDriver();
    const { url: agentUrl } = await startServerAgent({ seedRegions: ["TestRegion"] });
    const runner = new Runner(new DriverRegistry());

    const result = await runner.runTest(regionsTest(), mockDescriptor(driverUrl), driverUrl, EXEC, META, [
      agentConn(agentUrl),
    ]);

    expect(result.outcome).toBe("passed");
    const aps = stepByVerb(result, "assertPluginState");
    expect(aps?.outcome).toBe("passed"); // ran, did not skip
    expect(aps?.skip).toBeUndefined();
    expect(stepByVerb(result, "assertChat")?.outcome).toBe("passed");
  });

  it("2. honest skip preserved: NO agent → assertPluginState skips NO_COMPATIBLE_DRIVER unmet:[pluginState] (M2)", async () => {
    const driverUrl = await startDriver();
    const runner = new Runner(new DriverRegistry());

    const result = await runner.runTest(regionsTest(), mockDescriptor(driverUrl), driverUrl, EXEC, META);

    expect(result.outcome).toBe("passed"); // GUI half green; truth half honestly skipped
    const aps = stepByVerb(result, "assertPluginState");
    expect(aps?.outcome).toBe("skipped");
    expect(aps?.skip?.reason).toBe("NO_COMPATIBLE_DRIVER");
    expect(aps?.skip?.unmet).toEqual(["pluginState"]);
  });

  it("3. TRUTH/UI DIVERGENCE: chat says 'Region loaded' but regions.exists=false → RED on assertPluginState", async () => {
    // The driver's GUI/chat half PASSES (it pushes the chat line), but the server
    // agent reports the region missing — the runner must assert REAL state.
    const driverUrl = await startDriver();
    const { url: agentUrl } = await startServerAgent({ forceRegionMissing: true });
    const runner = new Runner(new DriverRegistry());

    const result = await runner.runTest(regionsTest(), mockDescriptor(driverUrl), driverUrl, EXEC, META, [
      agentConn(agentUrl),
    ]);

    expect(result.outcome).toBe("failed");
    expect(stepByVerb(result, "assertChat")?.outcome).toBe("passed"); // chat lied, and passed
    const aps = stepByVerb(result, "assertPluginState");
    expect(aps?.outcome).toBe("failed"); // real state caught it
    expect(aps?.skip).toBeUndefined(); // it RAN (matched=false), it did not skip
    expect(result.failure?.message).toContain("assertPluginState");
  });

  it("4. fixture-driven: a `fixture` step (routed to the agent) makes a later regions.exists true", async () => {
    const driverUrl = await startDriver();
    const { url: agentUrl } = await startServerAgent(); // no pre-seed
    const runner = new Runner(new DriverRegistry());

    const withFixture: NormalizedTest = {
      name: "regions-fixture-driven",
      requires: {},
      steps: [
        { index: 0, verb: "join", args: { username: "Tester" } },
        {
          index: 1,
          verb: "fixture",
          args: { fixture: "regions.createRegion", args: { name: "TestRegion" } },
          requires: { fixtures: true },
        },
        {
          index: 2,
          verb: "assertPluginState",
          args: { query: "regions.exists", args: { name: "TestRegion" }, expect: true },
          requires: { pluginState: true },
        },
      ],
    };
    const passed = await runner.runTest(withFixture, mockDescriptor(driverUrl), driverUrl, EXEC, META, [
      agentConn(agentUrl),
    ]);
    // The fixture made regions.exists true at assertion time → green (the agent
    // releases the session fixture on close, so we assert via the outcome).
    expect(passed.outcome).toBe("passed");
    expect(stepByVerb(passed, "fixture")?.outcome).toBe("passed");
    expect(stepByVerb(passed, "assertPluginState")?.outcome).toBe("passed");

    // Without the fixture step, the same assertion is RED (region never created).
    const { url: agentUrl2 } = await startServerAgent();
    const noFixture: NormalizedTest = {
      name: "regions-no-fixture",
      requires: {},
      steps: [
        { index: 0, verb: "join", args: { username: "Tester" } },
        {
          index: 1,
          verb: "assertPluginState",
          args: { query: "regions.exists", args: { name: "TestRegion" }, expect: true },
          requires: { pluginState: true },
        },
      ],
    };
    const failed = await runner.runTest(noFixture, mockDescriptor(driverUrl), driverUrl, EXEC, META, [
      agentConn(agentUrl2),
    ]);
    expect(failed.outcome).toBe("failed");
    expect(stepByVerb(failed, "assertPluginState")?.outcome).toBe("failed");
  });

  it("5. getBlock/getEntities routed to the agent; spawnFakePlayer makes a fake appear in getEntities", async () => {
    const driverUrl = await startDriver();
    const { url: agentUrl } = await startServerAgent({ block: { type: "minecraft:stone" } });
    const runner = new Runner(new DriverRegistry());

    const truthTest: NormalizedTest = {
      name: "truth-and-players",
      requires: {},
      steps: [
        { index: 0, verb: "join", args: { username: "Tester" } },
        { index: 1, verb: "getBlock", args: { world: "world", x: 0, y: 64, z: 0 }, requires: { worldTruth: true } },
        {
          index: 2,
          verb: "spawnFakePlayer",
          args: { name: "Bot2", at: { x: 1, y: 64, z: 1 } },
          requires: { fakePlayers: true },
        },
        {
          index: 3,
          verb: "getEntities",
          args: { center: { x: 0, y: 64, z: 0 }, radius: 16, type: "minecraft:player" },
          requires: { worldTruth: true },
        },
      ],
    };
    const result = await runner.runTest(truthTest, mockDescriptor(driverUrl), driverUrl, EXEC, META, [
      agentConn(agentUrl),
    ]);

    expect(result.outcome).toBe("passed");
    expect(stepByVerb(result, "getBlock")?.detail).toContain("minecraft:stone");
    // The spawned fake shows up: getEntities reports 1 player.
    expect(stepByVerb(result, "getEntities")?.detail).toContain("1 entit");
  });

  it("5b. getBlock `expect` asserts the block id — match → passed, mismatch → failed (the world-truth negative control)", async () => {
    const driverUrl = await startDriver();
    const { url: agentUrl } = await startServerAgent({ block: { type: "minecraft:bedrock" } });
    const runner = new Runner(new DriverRegistry());
    const getBlockExpect = (expectVal: string): NormalizedTest => ({
      name: "getblock-expect",
      requires: {},
      steps: [
        {
          index: 0,
          verb: "getBlock",
          args: { world: "world", x: 0, y: -64, z: 0, expect: expectVal },
          requires: { worldTruth: true },
        },
      ],
    });
    // Match → green, and the detail carries the asserted-vs-expected block id.
    const ok = await runner.runTest(getBlockExpect("minecraft:bedrock"), mockDescriptor(driverUrl), driverUrl, EXEC, META, [
      agentConn(agentUrl),
    ]);
    expect(ok.outcome).toBe("passed");
    expect(stepByVerb(ok, "getBlock")?.detail).toContain("expected minecraft:bedrock");
    // Mismatch → RED with a precise message (the mechanism behind worldtruth-negative.mctest.yml — proves
    // the assertion reads REAL agent state, never a rubber stamp).
    const bad = await runner.runTest(getBlockExpect("minecraft:diamond_block"), mockDescriptor(driverUrl), driverUrl, EXEC, META, [
      agentConn(agentUrl),
    ]);
    expect(bad.outcome).toBe("failed");
    expect(stepByVerb(bad, "getBlock")?.outcome).toBe("failed");
    expect(stepByVerb(bad, "getBlock")?.error?.message ?? "").toContain("block assertion failed");
  });

  it("6. one SessionGroup fans GUI to the driver and truth to the agent (no author plumbing)", async () => {
    const driverUrl = await startDriver();
    const { url: agentUrl, agent } = await startServerAgent({ seedRegions: ["TestRegion"] });
    const runner = new Runner(new DriverRegistry());

    const result = await runner.runTest(regionsTest(), mockDescriptor(driverUrl), driverUrl, EXEC, META, [
      agentConn(agentUrl),
    ]);
    expect(result.outcome).toBe("passed");

    // The agent received ONLY the truth/session calls — never the GUI verbs. The
    // GUI half is green, so those verbs went to the driver, not the agent: one
    // SessionGroup fanned them out with no author plumbing.
    expect(agent.calls).toContain("truth.assertPluginState");
    expect(agent.calls).not.toContain("screen.clickElement");
    expect(agent.calls).not.toContain("world.runCommand");
    expect(agent.calls).not.toContain("screen.waitForScreen");
  });

  it("a transport-unreachable agent drops out of the union (GUI green, truth half honestly skips)", async () => {
    const driverUrl = await startDriver();
    const runner = new Runner(new DriverRegistry());
    // Nothing is listening here → connect fails with ECONNREFUSED (a plain Error, not -32002).
    // The agent must still drop out of the union and the truth step honestly skip — never fail.
    const deadAgent: AgentConn = {
      url: "ws://127.0.0.1:59607/mctp",
      advertised: { ...SERVER_AGENT_CAPS },
      kind: "serverPlugin",
    };

    const result = await runner.runTest(regionsTest(), mockDescriptor(driverUrl), driverUrl, EXEC, META, [
      deadAgent,
    ]);

    expect(result.outcome).toBe("passed"); // GUI half green; truth half honestly skipped, NOT failed
    const aps = stepByVerb(result, "assertPluginState");
    expect(aps?.outcome).toBe("skipped");
    expect(aps?.skip?.unmet).toEqual(["pluginState"]);
  });

  it("an agent that refuses negotiation drops out of the union (its steps then honestly skip)", async () => {
    const driverUrl = await startDriver();
    // This "agent" advertises pluginState to the runner but its server only
    // grants worldTruth — so session.create for pluginState would still succeed
    // here; instead simulate a refusal by advertising caps the mock won't grant.
    const { url: agentUrl } = await startServerAgent({ capabilities: ["worldTruth"] });
    const runner = new Runner(new DriverRegistry());

    // The runner asks the agent for its full advertised set (incl. pluginState),
    // the mock refuses (-32002) → the agent is recorded but absent from the union.
    const result = await runner.runTest(regionsTest(), mockDescriptor(driverUrl), driverUrl, EXEC, META, [
      agentConn(agentUrl),
    ]);

    expect(result.outcome).toBe("passed"); // GUI half green; truth half honestly skipped
    const aps = stepByVerb(result, "assertPluginState");
    expect(aps?.outcome).toBe("skipped");
    expect(aps?.skip?.unmet).toEqual(["pluginState"]);
  });
});
