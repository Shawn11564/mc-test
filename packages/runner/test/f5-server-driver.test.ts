/**
 * F5 — the cost-1 `server` driver + server-truth-only sessions (no player join).
 *
 * This is the mechanism that lets a modded server be asserted WITHOUT a player:
 * a Mineflayer bot cannot complete Forge/NeoForge's FML handshake, so the
 * mod-loaded proof runs as a server-truth-only session where a co-selected server
 * agent IS the primary connection. Proven with NO Minecraft boot (ROADMAP §7.2):
 * the mock server agent answers the loader-provided `mod.loaded` built-in query.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  Runner,
  DriverRegistry,
  defaultRegistry,
  SERVER_DRIVER_CAPABILITIES,
  SERVER_DRIVER_SENTINEL,
  type AgentConn,
  type DriverDescriptor,
  type NormalizedTest,
  type TestResult,
} from "../src/index.js";
import { MockServerAgent, type MockServerAgentOptions } from "./mockServerAgent.js";

const META = { target: "mock-fabric-server", loader: "fabric", mc: "1.21.1" };
const EXEC = { host: "127.0.0.1", port: 25565, defaultUsername: "Tester" };

const serverAgents: MockServerAgent[] = [];
afterEach(async () => {
  await Promise.all(serverAgents.splice(0).map((a) => a.stop()));
});

async function startServerAgent(opts?: MockServerAgentOptions): Promise<{ url: string; agent: MockServerAgent }> {
  const agent = new MockServerAgent(opts);
  serverAgents.push(agent);
  const { url } = await agent.start();
  return { url, agent };
}

/** The real `server` driver descriptor (id "server", no process — sentinel URL). */
function serverDescriptor(): DriverDescriptor {
  return {
    id: "server",
    kind: "serverAgent",
    cost: 1,
    advertised: { ...SERVER_DRIVER_CAPABILITIES },
    create: async () => ({ url: SERVER_DRIVER_SENTINEL, stop: async () => {} }),
  };
}

function agentConn(url: string): AgentConn {
  return {
    url,
    advertised: { worldTruth: true, pluginState: true, fixtures: true, fakePlayers: true, chat: true, testIdTags: true },
    kind: "serverMod",
  };
}

function stepByVerb(result: TestResult, verb: string) {
  return result.steps.find((s) => s.verb === verb);
}

/** A server-truth-only test: join (no player) + assert a mod is loaded. */
function modLoadedTest(modId: string): NormalizedTest {
  return {
    name: "ferritecore-loaded",
    requires: { pluginState: true },
    steps: [
      { index: 0, verb: "join", args: {} },
      {
        index: 1,
        verb: "assertPluginState",
        args: { query: "mod.loaded", args: { id: modId }, expect: true },
        requires: { pluginState: true },
      },
    ],
  };
}

const tnt = (name: string, requires: NormalizedTest["requires"]): NormalizedTest => ({ name, requires, steps: [] });

describe("F5 server driver: selection (cost 1, server-owned caps only)", () => {
  it("defaultRegistry registers `server` at cost 1 (kind serverAgent), cheaper than every UI driver", () => {
    const reg = defaultRegistry();
    const server = reg.list().find((d) => d.id === "server");
    expect(server, "defaultRegistry must register a server driver").toBeDefined();
    expect(server!.kind).toBe("serverAgent");
    expect(server!.cost).toBe(1);
    expect(server!.advertised.pluginState).toBe(true);
    for (const other of reg.list().filter((d) => d.id !== "server")) {
      expect(server!.cost).toBeLessThan(other.cost);
    }
  });

  it("a server-truth-only test (pluginState / worldTruth / fixtures) picks `server`", () => {
    const runner = new Runner(defaultRegistry());
    expect(runner.selectDriver(tnt("ps", { pluginState: true })).descriptor?.id).toBe("server");
    expect(runner.selectDriver(tnt("wt", { worldTruth: true })).descriptor?.id).toBe("server");
    expect(runner.selectDriver(tnt("fx", { fixtures: true })).descriptor?.id).toBe("server");
  });

  it("UI tests never match `server` — they fall through to headless/inprocess (no regression)", () => {
    const runner = new Runner(defaultRegistry());
    // The canonical headless regions test (command + containerGui) still picks headless.
    expect(runner.selectDriver(tnt("gui", { command: true, containerGui: true })).descriptor?.id).toBe("headless");
    expect(runner.selectDriver(tnt("cs", { clientScreens: true })).descriptor?.id).toBe("inprocess");
  });
});

describe("F5 server driver: server-truth-only sessions", () => {
  it("promotes the co-selected agent to primary; `mod.loaded` runs (no player join) and is GREEN", async () => {
    const { url, agent } = await startServerAgent({ seedMods: ["ferritecore"] });
    const runner = new Runner(new DriverRegistry());

    const result = await runner.runTest(modLoadedTest("ferritecore"), serverDescriptor(), SERVER_DRIVER_SENTINEL, EXEC, META, [
      agentConn(url),
    ]);

    expect(result.outcome).toBe("passed");
    // join was a no-op (no real world.join sent), assertPluginState ran on the agent.
    expect(stepByVerb(result, "join")?.detail).toContain("server-truth");
    expect(agent.calls).not.toContain("world.join");
    const aps = stepByVerb(result, "assertPluginState");
    expect(aps?.outcome).toBe("passed");
    expect(agent.calls).toContain("truth.assertPluginState");
  });

  it("NEGATIVE control: asserting a mod that is NOT loaded goes RED (not a rubber stamp)", async () => {
    const { url } = await startServerAgent({ seedMods: ["something-else"] });
    const runner = new Runner(new DriverRegistry());

    const result = await runner.runTest(modLoadedTest("ferritecore"), serverDescriptor(), SERVER_DRIVER_SENTINEL, EXEC, META, [
      agentConn(url),
    ]);

    expect(result.outcome).toBe("failed");
    expect(stepByVerb(result, "assertPluginState")?.outcome).toBe("failed");
  });

  it("`server` driver with NO co-selected agent → honest skip NO_SERVER_AGENT (never a crash/false green)", async () => {
    const runner = new Runner(new DriverRegistry());
    const result = await runner.runTest(modLoadedTest("ferritecore"), serverDescriptor(), SERVER_DRIVER_SENTINEL, EXEC, META, []);

    expect(result.outcome).toBe("skipped");
    expect(result.skip?.reason).toBe("NO_SERVER_AGENT");
    expect(result.skip?.unmet).toContain("pluginState");
  });

  it("a UI step in a server-truth session honestly skips (union has no containerGui/clientScreens)", async () => {
    const { url } = await startServerAgent({ seedMods: ["ferritecore"] });
    const runner = new Runner(new DriverRegistry());
    const mixed: NormalizedTest = {
      name: "mixed",
      requires: { pluginState: true },
      steps: [
        { index: 0, verb: "click", args: { label: "Regions" } },
        {
          index: 1,
          verb: "assertPluginState",
          args: { query: "mod.loaded", args: { id: "ferritecore" }, expect: true },
          requires: { pluginState: true },
        },
      ],
    };
    const result = await runner.runTest(mixed, serverDescriptor(), SERVER_DRIVER_SENTINEL, EXEC, META, [agentConn(url)]);

    // The mod.loaded assertion passed; the GUI click honestly skipped — overall not a failure.
    expect(result.outcome).toBe("passed");
    expect(stepByVerb(result, "click")?.outcome).toBe("skipped");
    expect(stepByVerb(result, "click")?.skip?.reason).toBe("NO_COMPATIBLE_DRIVER");
    expect(stepByVerb(result, "assertPluginState")?.outcome).toBe("passed");
  });
});
