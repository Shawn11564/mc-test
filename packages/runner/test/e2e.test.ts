/**
 * End-to-end engine tests against the mock MCTP agent (no Minecraft boot).
 * Proves: capability negotiation, step→MCTP mapping, SelectorWaits retry/timeout,
 * per-step honest skips, fluent≡YAML identical pass, the mutation negative
 * control, and JUnit output — the full loop the real boot also exercises.
 */
import { describe, it, expect, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import {
  Runner,
  DriverRegistry,
  loadSteps,
  renderJUnit,
  test as authorTest,
  type DriverDescriptor,
  type NormalizedTest,
  type TestResult,
} from "../src/index.js";
import { MockAgent, type MockAgentOptions } from "./mockAgent.js";

const yamlPath = fileURLToPath(new URL("../../../examples/regions/regions.mctest.yml", import.meta.url));

const HEADLESS_CAPS = {
  chat: true,
  command: true,
  containerGui: true,
  typeText: true,
  pressKey: true,
} as const;

const META = { target: "mock-paper", loader: "paper", mc: "1.20.4" };
const EXEC = { host: "127.0.0.1", port: 25565, defaultUsername: "Tester" };

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

function mockDescriptor(url: string): DriverDescriptor {
  return {
    id: "headless",
    kind: "headlessBot",
    cost: 2,
    advertised: { ...HEADLESS_CAPS },
    create: async () => ({ url, stop: async () => {} }),
  };
}

function fluentRegions(): NormalizedTest {
  return authorTest("regions-open-testregion")
    .requires({ command: true, containerGui: true })
    .join({ host: "localhost", port: 25565, username: "Tester" })
    .command("or")
    .waitForScreen({ titleContains: "OpenRegions" })
    .click({ label: "Regions" })
    .click({ label: "TestRegion" })
    .assertChat({ contains: "Region loaded" })
    .assertPluginState({
      requires: { pluginState: true },
      plugin: "OpenRegions",
      query: "regions.exists",
      args: { name: "TestRegion" },
      expect: true,
    })
    .build();
}

function stepByVerb(result: TestResult, verb: string) {
  return result.steps.find((s) => s.verb === verb);
}

describe("regions E2E against the mock agent", () => {
  it("passes the YAML test and honestly skips assertPluginState", async () => {
    const url = await startAgent();
    const runner = new Runner(new DriverRegistry());
    const test = loadSteps(yamlPath);
    const result = await runner.runTest(test, mockDescriptor(url), url, EXEC, META);

    expect(result.outcome).toBe("passed");
    expect(stepByVerb(result, "command")?.outcome).toBe("passed");
    expect(stepByVerb(result, "click")?.outcome).toBe("passed");
    expect(stepByVerb(result, "assertChat")?.outcome).toBe("passed");

    const aps = stepByVerb(result, "assertPluginState");
    expect(aps?.outcome).toBe("skipped");
    expect(aps?.skip?.reason).toBe("NO_COMPATIBLE_DRIVER");
    expect(aps?.skip?.unmet).toEqual(["pluginState"]);
  });

  it("the fluent API produces an identical pass", async () => {
    const url = await startAgent();
    const runner = new Runner(new DriverRegistry());
    const yamlResult = await runner.runTest(loadSteps(yamlPath), mockDescriptor(url), url, EXEC, META);

    const url2 = await startAgent();
    const fluentResult = await runner.runTest(fluentRegions(), mockDescriptor(url2), url2, EXEC, META);

    expect(fluentResult.outcome).toBe(yamlResult.outcome);
    expect(fluentResult.steps.map((s) => [s.verb, s.outcome])).toEqual(
      yamlResult.steps.map((s) => [s.verb, s.outcome]),
    );
    expect(fluentResult.outcome).toBe("passed");
  });

  it("emits JUnit with a green test and a visible skipped-step testcase", async () => {
    const url = await startAgent();
    const runner = new Runner(new DriverRegistry());
    const result = await runner.runTest(loadSteps(yamlPath), mockDescriptor(url), url, EXEC, META);
    const xml = renderJUnit([result]);

    expect(xml).toContain('name="regions-open-testregion"');
    expect(xml).toContain("regions-open-testregion » assertPluginState");
    expect(xml).toContain("NO_COMPATIBLE_DRIVER unmet:[pluginState]");
    // main test is green: no <failure>; the only <skipped> is the companion step.
    expect(xml).not.toContain("<failure");
    expect(xml).toContain('failures="0"');
  });

  it("MUTATION negative control: renaming Regions→Zones turns it red with ELEMENT_NOT_FOUND", async () => {
    const url = await startAgent({ regionsButtonLabel: "Zones" });
    const runner = new Runner(new DriverRegistry());
    const mutation: NormalizedTest = {
      name: "regions-mutation",
      requires: { command: true, containerGui: true },
      steps: [
        { index: 0, verb: "join", args: { username: "Tester" } },
        { index: 1, verb: "command", args: "or" },
        { index: 2, verb: "waitForScreen", args: { titleContains: "OpenRegions", timeoutMs: 2000 } },
        { index: 3, verb: "click", args: { label: "Regions", timeoutMs: 800 } },
      ],
    };
    const result = await runner.runTest(mutation, mockDescriptor(url), url, EXEC, META);

    expect(result.outcome).toBe("failed");
    const click = result.steps.find((s) => s.verb === "click");
    expect(click?.outcome).toBe("failed");
    expect(click?.error?.reason).toBe("ELEMENT_NOT_FOUND");
  });

  it("SelectorWaits retries a transient ELEMENT_NOT_FOUND until the list populates", async () => {
    const url = await startAgent({ listAppearAfter: 3 });
    const runner = new Runner(new DriverRegistry());
    const result = await runner.runTest(loadSteps(yamlPath), mockDescriptor(url), url, EXEC, META);
    expect(result.outcome).toBe("passed");
    // both clicks succeeded despite the list being "late"
    expect(result.steps.filter((s) => s.verb === "click").every((s) => s.outcome === "passed")).toBe(true);
  });

  it("a test requiring an unadvertised capability skips with NO_COMPATIBLE_DRIVER", async () => {
    const registry = new DriverRegistry();
    registry.register({
      id: "headless",
      kind: "headlessBot",
      cost: 2,
      advertised: { ...HEADLESS_CAPS },
      create: async () => ({ url: "", stop: async () => {} }),
    });
    const runner = new Runner(registry);
    const needsClient = authorTest("needs-client")
      .requires({ command: true, clientScreens: true })
      .command("or")
      .build();
    const selection = runner.selectDriver(needsClient);
    expect(selection.descriptor).toBeUndefined();
    expect(selection.skip?.reason).toBe("NO_COMPATIBLE_DRIVER");
    expect(selection.skip?.unmet).toContain("clientScreens");
  });
});
