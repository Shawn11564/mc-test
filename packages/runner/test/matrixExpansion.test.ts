import { describe, expect, it } from "vitest";
import { expandMatrix, parseStepDocument, buildResultsReport, DriverRegistry, Runner, type DriverDescriptor } from "../src/index.js";
import type { TestResult } from "../src/model/result.js";
import { MockAgent } from "./mockAgent.js";

const TOY = {
  name: "toy-placement",
  matrix: {
    face: { values: ["north", "south"], bind: { step: "useBlock", param: "face" } },
    held: { values: { empty: null, sign: "oak_sign" }, bind: { setup: "give-and-hold" } },
  },
  coverage: "full",
  steps: [
    { useBlock: { pos: { x: 0, y: 64, z: 0 }, face: "$face" } },
    { setHeldItem: { item: "$held" } },
  ],
};

describe("§4 matrix expansion", () => {
  it("expands a 2×2 matrix with concrete parameter and setup bindings", () => {
    const cases = expandMatrix(parseStepDocument(TOY, "toy.mctest.yml"));

    expect(cases).toHaveLength(4);
    expect(cases.map((c) => c.id)).toEqual([
      "face=north,held=empty",
      "face=north,held=sign",
      "face=south,held=empty",
      "face=south,held=sign",
    ]);
    expect(cases[0]!.test.steps[0]).toMatchObject({ verb: "fixture", args: { reset: true } });
    expect(cases[0]!.test.steps.find((step) => step.verb === "useBlock")).toMatchObject({ args: { face: "north" } });
    expect(cases[0]!.test.steps.find((step) => step.verb === "setHeldItem")).toMatchObject({ args: { item: null } });
    expect(cases[0]!.test.steps.find((step) => step.index === -2)).toMatchObject({ verb: "fixture", args: { name: "give-and-hold", args: { held: null } } });
    expect(cases[1]!.setup).toEqual([{ action: "give-and-hold", dimension: "held", value: "oak_sign" }]);
  });

  it("uses a pairwise subset while covering every value-pair", () => {
    const test = parseStepDocument({
      name: "three-dimensions",
      matrix: {
        a: { values: ["a0", "a1"] },
        b: { values: ["b0", "b1"] },
        c: { values: ["c0", "c1"] },
      },
      coverage: "pairwise",
      steps: [{ chat: "case $a/$b/$c" }],
    }, "pairwise.mctest.yml");
    const cases = expandMatrix(test);
    expect(cases.length).toBeLessThan(8);
    const observed = new Set<string>();
    for (const c of cases) {
      for (const [left, right] of [["a", "b"], ["a", "c"], ["b", "c"]] as const) {
        observed.add(`${left}:${c.config[left]}|${right}:${c.config[right]}`);
      }
    }
    expect(observed.size).toBe(12);
  });

  it("writes each expanded case config and verdict into results.json data", () => {
    const cases = expandMatrix(parseStepDocument(TOY, "toy.mctest.yml"));
    const results: TestResult[] = cases.map((c, i) => ({
      name: c.test.name,
      target: "toy-target",
      outcome: i === 3 ? "failed" : "passed",
      durationMs: 10,
      steps: [],
      matrixCase: {
        id: c.id,
        config: c.config,
        coverage: c.coverage,
        environmentKey: c.environmentKey,
      },
    }));
    const report = buildResultsReport(results, "toy-target");

    expect(report.coverage_model).toBe("full");
    expect(report.cases).toHaveLength(4);
    expect(report.cases[0]).toMatchObject({
      id: "toy-placement[face=north,held=empty]@toy-target",
      config: { target: "toy-target", face: "north", held: "empty" },
      status: "pass",
    });
    expect(report.cases[3]!.status).toBe("fail");
  });

  it("runs cases in the same environment variant under one boot", async () => {
    const test = parseStepDocument({
      name: "boot-group",
      matrix: {
        mode: { values: ["a", "b"], bind: { environment: "server-mode" } },
        value: { values: [1, 2] },
      },
      steps: [{ command: "say $mode-$value" }],
    }, "boot-group.mctest.yml");
    const cases = expandMatrix(test);
    const agent = new MockAgent({ capabilities: ["command"] });
    const { url } = await agent.start();
    try {
      const registry = new DriverRegistry();
      const descriptor: DriverDescriptor = {
        id: "headless", kind: "headlessBot", cost: 1, advertised: { command: true },
        create: async () => ({ url, stop: async () => {} }),
      };
      registry.register(descriptor);
      const runner = new Runner(registry);
      let boots = 0;
      const results = await runner.runTargetCases(
        cases.filter((c) => c.environmentKey === "server-mode=a").map((c) => c.test),
        { target: "mock", loader: "paper", mc: "1.20.4" },
        async () => ({ host: "127.0.0.1", port: 25565, stop: async () => { boots++; } }),
      );
      expect(results).toHaveLength(2);
      expect(results.every((result) => result.outcome === "passed")).toBe(true);
      expect(boots).toBe(1);
      expect(results.every((result) => result.matrixCase?.environmentKey === "server-mode=a")).toBe(true);
    } finally {
      await agent.stop();
    }
  });
});
