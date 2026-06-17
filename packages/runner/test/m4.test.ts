/**
 * M4 "testing the tester" layer — the verb-level anyOf gating, mixed-driver
 * selection (headless vs in-process), combined client+server session, and honest
 * skips, proven with NO Minecraft boot (ROADMAP §5.4/§7.2/§7.3). One
 * `SessionGroup` fans GUI/chat steps to the in-process (rendered-client) mock and
 * truth/fixture/player steps to the mock server agent; the author writes no
 * connection plumbing.
 *
 * The headline M4 controls:
 *  - a `clientScreens` test is GREEN on the in-process driver but SKIPS on a
 *    headless-only driver (`unmet:["clientScreens"]`) — the one thing the bot
 *    cannot see;
 *  - the screen-navigation verbs gate on `containerGui` **OR** `clientScreens`
 *    (anyOf), so a `clientScreens`-only driver still routes + runs `click`;
 *  - a `screenshot` step honestly skips when the driver lacks `screenshot`, and a
 *    server-owned `assertPluginState` honestly skips when no agent is co-connected.
 */
import { describe, it, expect, afterEach } from "vitest";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import {
  Runner,
  DriverRegistry,
  defaultRegistry,
  type AgentConn,
  type Capabilities,
  type DriverDescriptor,
  type NormalizedTest,
  type TestResult,
} from "../src/index.js";
import { MockClientAgent, type MockClientAgentOptions } from "./mockClientAgent.js";
import { MockServerAgent, type MockServerAgentOptions } from "./mockServerAgent.js";

/** The in-process driver's advertised set (mirrors INPROCESS_CAPABILITIES). */
const INPROCESS_CAPS: Capabilities = {
  chat: true,
  command: true,
  containerGui: true,
  clientScreens: true,
  typeText: true,
  pressKey: true,
  testIdTags: true,
  screenshot: true,
  rendering: true,
};

/** A headless-like driver: container GUIs only, NO clientScreens / screenshot. */
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

const META = { target: "mock-fabric-client", loader: "fabric", mc: "1.21.1" };
const EXEC = { host: "127.0.0.1", port: 25565, defaultUsername: "Tester" };

// --- live mock lifecycle ----------------------------------------------------
const clients: MockClientAgent[] = [];
const serverAgents: MockServerAgent[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((a) => a.stop()));
  await Promise.all(serverAgents.splice(0).map((a) => a.stop()));
});

async function startClient(opts?: MockClientAgentOptions): Promise<{ url: string; agent: MockClientAgent }> {
  const agent = new MockClientAgent(opts);
  clients.push(agent);
  const { url } = await agent.start();
  return { url, agent };
}
async function startServerAgent(opts?: MockServerAgentOptions): Promise<{ url: string; agent: MockServerAgent }> {
  const agent = new MockServerAgent(opts);
  serverAgents.push(agent);
  const { url } = await agent.start();
  return { url, agent };
}

/** A driver descriptor over a live mock url, with the given advertised caps. */
function mockDescriptor(url: string, advertised: Capabilities, id = "inprocess", cost = 3): DriverDescriptor {
  return {
    id,
    kind: id === "inprocess" ? "clientMod" : "headlessBot",
    cost,
    advertised: { ...advertised },
    create: async () => ({ url, stop: async () => {} }),
  };
}

function agentConn(url: string): AgentConn {
  return { url, advertised: { ...SERVER_AGENT_CAPS }, kind: "serverPlugin" };
}

function stepByVerb(result: TestResult, verb: string) {
  return result.steps.find((s) => s.verb === verb);
}

/** The client-GUI regions test (testId selectors, the rendered-client form). */
function clientRegionsTest(extra: NormalizedStep[] = []): NormalizedTest {
  return {
    name: "regions-clientgui",
    requires: { command: true, chat: true, clientScreens: true },
    steps: [
      { index: 0, verb: "join", args: { username: "Tester" } },
      { index: 1, verb: "command", args: "or" },
      { index: 2, verb: "waitForScreen", args: { titleContains: "Regions" } },
      { index: 3, verb: "click", args: { testId: "regions:root:regions" } },
      { index: 4, verb: "click", args: { testId: "regions:entry:TestRegion" } },
      { index: 5, verb: "assertChat", args: { contains: "Region loaded" } },
      ...extra.map((s, i) => ({ ...s, index: 6 + i })),
    ],
  };
}
type NormalizedStep = NormalizedTest["steps"][number];

describe("M4 client GUI: anyOf gating, mixed-driver selection, combined session", () => {
  it("1. mixed-suite selection: containerGui→headless, clientScreens→inprocess, clientScreens w/ headless-only→skip", async () => {
    // A populated registry: headless (cost 2) + inprocess (cost 3).
    const registry = new DriverRegistry();
    registry.register(mockDescriptor("", HEADLESS_CAPS, "headless", 2));
    registry.register(mockDescriptor("", INPROCESS_CAPS, "inprocess", 3));
    const runner = new Runner(registry);

    const containerTest: NormalizedTest = {
      name: "container-only",
      requires: { command: true, containerGui: true },
      steps: [{ index: 0, verb: "command", args: "or" }],
    };
    const clientTest: NormalizedTest = {
      name: "client-only",
      requires: { command: true, clientScreens: true },
      steps: [{ index: 0, verb: "command", args: "or" }],
    };

    // containerGui test → the CHEAPER headless (adding inprocess must not change this).
    expect(runner.selectDriver(containerTest).descriptor?.id).toBe("headless");
    // clientScreens test → only inprocess can satisfy it.
    expect(runner.selectDriver(clientTest).descriptor?.id).toBe("inprocess");

    // A registry with ONLY headless → the clientScreens test honestly skips.
    const headlessOnly = new DriverRegistry();
    headlessOnly.register(mockDescriptor("", HEADLESS_CAPS, "headless", 2));
    const skipSel = new Runner(headlessOnly).selectDriver(clientTest);
    expect(skipSel.descriptor).toBeUndefined();
    expect(skipSel.skip?.reason).toBe("NO_COMPATIBLE_DRIVER");
    expect(skipSel.skip?.unmet).toEqual(["clientScreens"]);
  });

  it("1b. defaultRegistry: containerGui still picks headless; clientScreens picks inprocess (cost order)", () => {
    const runner = new Runner(defaultRegistry());
    const containerTest: NormalizedTest = {
      name: "c",
      requires: { containerGui: true },
      steps: [],
    };
    const clientTest: NormalizedTest = {
      name: "cs",
      requires: { clientScreens: true },
      steps: [],
    };
    expect(runner.selectDriver(containerTest).descriptor?.id).toBe("headless");
    expect(runner.selectDriver(clientTest).descriptor?.id).toBe("inprocess");
  });

  it("2. clientScreens GREEN on the in-process driver (the bot fundamentally cannot see this)", async () => {
    const { url } = await startClient();
    const runner = new Runner(new DriverRegistry());

    const result = await runner.runTest(clientRegionsTest(), mockDescriptor(url, INPROCESS_CAPS), url, EXEC, META);

    expect(result.outcome).toBe("passed");
    expect(stepByVerb(result, "waitForScreen")?.outcome).toBe("passed");
    // both clicks (testId selectors) ran against the client agent
    expect(result.steps.filter((s) => s.verb === "click").every((s) => s.outcome === "passed")).toBe(true);
    expect(stepByVerb(result, "assertChat")?.outcome).toBe("passed");
  });

  it("3. honest skip: a screenshot step skips unmet:[screenshot] on a headless-like driver; assertPluginState skips unmet:[pluginState] w/o an agent", async () => {
    // A headless-like client agent that advertises only containerGui (NOT clientScreens/screenshot).
    const { url } = await startClient({ capabilities: ["chat", "command", "containerGui", "typeText", "pressKey"] });
    const runner = new Runner(new DriverRegistry());

    // The same regions flow, but as a containerGui (anyOf) test, with a trailing
    // `screenshot` and a server-owned `assertPluginState` step.
    const test: NormalizedTest = {
      name: "honest-skip-mix",
      requires: { command: true, chat: true, containerGui: true },
      steps: [
        { index: 0, verb: "join", args: { username: "Tester" } },
        { index: 1, verb: "command", args: "or" },
        { index: 2, verb: "waitForScreen", args: { titleContains: "Regions" } },
        { index: 3, verb: "click", args: { testId: "regions:root:regions" } },
        { index: 4, verb: "click", args: { testId: "regions:entry:TestRegion" } },
        { index: 5, verb: "assertChat", args: { contains: "Region loaded" } },
        { index: 6, verb: "screenshot", args: {} },
        {
          index: 7,
          verb: "assertPluginState",
          args: { plugin: "OpenRegions", query: "regions.exists", args: { name: "TestRegion" }, expect: true },
          requires: { pluginState: true },
        },
      ],
    };
    // No agent co-connected → pluginState honestly skips; screenshot honestly skips.
    const result = await runner.runTest(test, mockDescriptor(url, HEADLESS_CAPS, "headless", 2), url, EXEC, META);

    // The GUI half still runs (containerGui is present → the anyOf click routes/runs).
    expect(result.outcome).toBe("passed");
    expect(result.steps.filter((s) => s.verb === "click").every((s) => s.outcome === "passed")).toBe(true);

    const shot = stepByVerb(result, "screenshot");
    expect(shot?.outcome).toBe("skipped");
    expect(shot?.skip?.reason).toBe("NO_COMPATIBLE_DRIVER");
    expect(shot?.skip?.unmet).toEqual(["screenshot"]);

    const aps = stepByVerb(result, "assertPluginState");
    expect(aps?.outcome).toBe("skipped");
    expect(aps?.skip?.unmet).toEqual(["pluginState"]);
  });

  it("4. combined client+server session: GUI verbs → the client driver, assertPluginState → the server agent", async () => {
    const { url: clientUrl, agent: client } = await startClient();
    const { url: agentUrl, agent: server } = await startServerAgent({ seedRegions: ["TestRegion"] });
    const runner = new Runner(new DriverRegistry());

    const test = clientRegionsTest([
      {
        index: 0, // re-indexed by clientRegionsTest
        verb: "assertPluginState",
        args: { plugin: "OpenRegions", query: "regions.exists", args: { name: "TestRegion" }, expect: true },
        requires: { pluginState: true },
      },
    ]);

    const result = await runner.runTest(test, mockDescriptor(clientUrl, INPROCESS_CAPS), clientUrl, EXEC, META, [
      agentConn(agentUrl),
    ]);

    expect(result.outcome).toBe("passed");
    expect(stepByVerb(result, "assertPluginState")?.outcome).toBe("passed");

    // The server agent received ONLY the truth/session calls — never the GUI verbs.
    expect(server.calls).toContain("truth.assertPluginState");
    expect(server.calls).not.toContain("screen.clickElement");
    expect(server.calls).not.toContain("screen.waitForScreen");
    expect(server.calls).not.toContain("world.runCommand");
    // The client agent got the GUI verbs (and not the truth call).
    expect(client.calls).toContain("screen.clickElement");
    expect(client.calls).toContain("screen.waitForScreen");
    expect(client.calls).not.toContain("truth.assertPluginState");
  });

  it("5. anyOf routing: a `click` on a driver advertising ONLY clientScreens (no containerGui) still routes + runs", async () => {
    // The proof that the verb anyOf (containerGui|clientScreens) is what routes —
    // not merely that inprocess happens to also advertise containerGui.
    const clientOnlyCaps: Capabilities = {
      chat: true,
      command: true,
      clientScreens: true, // NOTE: NO containerGui
      typeText: true,
      pressKey: true,
      testIdTags: true,
    };
    const { url, agent } = await startClient({
      capabilities: ["chat", "command", "clientScreens", "typeText", "pressKey", "testIdTags"],
    });
    const runner = new Runner(new DriverRegistry());

    const result = await runner.runTest(clientRegionsTest(), mockDescriptor(url, clientOnlyCaps), url, EXEC, META);

    expect(result.outcome).toBe("passed");
    expect(result.steps.filter((s) => s.verb === "click").every((s) => s.outcome === "passed")).toBe(true);
    expect(stepByVerb(result, "waitForScreen")?.outcome).toBe("passed");
    // The clicks reached the client agent (routed via the clientScreens anyOf member).
    expect(agent.calls).toContain("screen.clickElement");
  });

  it("6. import-scan: no net.minecraft/yarn import outside agents/client-fabric/src/.../mappings/Names.java", () => {
    // The mappings-quarantine rule (CLAUDE.md Prime Directive 2; ROADMAP §8.1): all
    // obfuscation-mapped (Yarn) symbols live ONLY in mappings/Names.java. Partition B
    // owns agents/client-fabric; tolerate the dir being absent (parallel build order).
    // Scoped to PRODUCTION code (src/main): the mapping-contract test under src/test legitimately
    // references mapped names (as Class.forName strings) to assert they resolve — out of scope here.
    const root = fileURLToPath(new URL("../../../agents/client-fabric/src/main", import.meta.url));
    if (!existsSync(root)) {
      // B has not landed in this tree yet — nothing to scan, do not fail.
      return;
    }

    const javaFiles: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (name.endsWith(".java")) javaFiles.push(full);
      }
    };
    walk(root);
    expect(javaFiles.length).toBeGreaterThan(0); // sanity: the shim has Java sources

    // Cover every obfuscation-mapped / client-internal namespace the shim must quarantine — not just
    // net.minecraft: GLFW input, the Mojang auth/serialization/blaze3d libs, and Yarn symbols all count
    // (M4_PLAN §B names GLFW + ScreenshotRecorder as Names.java-only). A narrow regex would let e.g.
    // `import org.lwjgl.glfw.GLFW;` leak past green.
    const MAPPED =
      /\b(?:import\s+net\.minecraft|net\.minecraft\.|net\.fabricmc\.yarn|org\.lwjgl\.glfw|com\.mojang\.(?:blaze3d|authlib|serialization|datafixers))/;
    const namesPath = javaFiles.find((f) => f.replace(/\\/g, "/").endsWith("/mappings/Names.java"));
    // The guard must be non-vacuous: the quarantined file itself MUST contain mapped symbols, proving
    // the regex actually matches the obfuscation namespaces (else a leak elsewhere could pass silently).
    expect(namesPath, "expected agents/client-fabric .../mappings/Names.java").toBeDefined();
    expect(MAPPED.test(readFileSync(namesPath!, "utf8"))).toBe(true);

    const leaks: string[] = [];
    for (const file of javaFiles) {
      if (file === namesPath) continue; // the single quarantined file is allowed mapped symbols
      const src = readFileSync(file, "utf8");
      if (MAPPED.test(src)) leaks.push(relative(root, file).replace(/\\/g, "/"));
    }
    expect(leaks, `mapped (Yarn/net.minecraft/GLFW/Mojang) symbols leaked outside mappings/Names.java: ${leaks.join(", ")}`).toEqual([]);
  });
});
