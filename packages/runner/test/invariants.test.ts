/**
 * The `expect:` invariant DSL (spec commandcenter/40-testing-loop.md §4–§5).
 *
 * The point of an invariant is that ONE oracle, written once, judges every
 * generated case — its expected values are functions of the case config, not 36
 * hand-written assertions that can be quietly reshaped to match whatever the
 * code did. So these tests cover, in order: branch selection (`when:`), `$dim`
 * resolution (including `pos: "chest + $face"`), the parse-time refusals that
 * keep a malformed oracle from passing vacuously, an end-to-end pass AND fail
 * against a MockAgent world, and what lands in results.json.
 */
import { describe, expect, it } from "vitest";
import {
  DriverRegistry,
  Runner,
  applyInvariants,
  buildResultsReport,
  compileInvariantSteps,
  declaredCaseCount,
  expandMatrix,
  parseStepDocument,
  resolvePos,
  selectBranches,
  whenMatches,
  type DriverDescriptor,
} from "../src/index.js";
import { MockAgent } from "./mockAgent.js";

/** The canonical §4 shape: sign placement judged by one branch per neighbor state. */
const PLACEMENT = {
  name: "placement",
  requires: { worldInteraction: true, worldTruth: true, chat: true },
  matrix: {
    face: { values: ["north", "south"], bind: { step: "useBlock", param: "face" } },
    neighbor: { values: { free: null, occupied: "minecraft:stone" } },
  },
  anchors: { chest: { x: 0, y: 64, z: 0 } },
  steps: [
    { setHeldItem: { item: "minecraft:oak_sign" } },
    { useBlock: { pos: { x: 0, y: 64, z: 0 }, sneak: true } },
  ],
  expect: [
    {
      when: { neighbor: "free" },
      because: "a sneak-click places the sign on the face we clicked",
      block: { pos: "chest + $face", is: "*_sign" },
    },
    {
      when: { neighbor: "occupied" },
      block: { pos: "chest + $face", is: "minecraft:stone" },
      chat: { contains: "face is blocked" },
    },
  ],
};

const CASE_IDS = {
  northFree: "face=north,neighbor=free",
  northOccupied: "face=north,neighbor=occupied",
  southFree: "face=south,neighbor=free",
  southOccupied: "face=south,neighbor=occupied",
};

/** A driver descriptor over the mock's URL, advertising exactly `caps`. */
function mockDriver(url: string, caps: Record<string, boolean>): DriverDescriptor {
  return {
    id: "headless",
    kind: "headlessBot",
    cost: 1,
    advertised: caps,
    create: async () => ({ url, stop: async () => {} }),
  };
}

async function runCases(
  agent: MockAgent,
  tests: ReturnType<typeof parseStepDocument>[],
  caps: Record<string, boolean> = { worldInteraction: true, worldTruth: true, chat: true },
) {
  const { url } = await agent.start();
  try {
    const registry = new DriverRegistry();
    registry.register(mockDriver(url, caps));
    const runner = new Runner(registry);
    return await runner.runTargetCases(tests, { target: "mock", loader: "paper", mc: "1.21.1" }, async () => ({
      host: "127.0.0.1",
      port: 25565,
      stop: async () => {},
    }));
  } finally {
    await agent.stop();
  }
}

describe("§4 expect: branch selection", () => {
  const test = parseStepDocument(PLACEMENT, "placement.mctest.yml");

  it("selects the branch whose when: matches the case, and only that one", () => {
    const free = selectBranches(test, { face: "north", neighbor: "free" }, { face: "north", neighbor: null });
    expect(free.map((s) => s.ref)).toEqual(["placement#expect[0]"]);
    const occupied = selectBranches(
      test,
      { face: "north", neighbor: "occupied" },
      { face: "north", neighbor: "minecraft:stone" },
    );
    expect(occupied.map((s) => s.ref)).toEqual(["placement#expect[1]"]);
  });

  it("matches either the symbolic label or the concrete value of a map-form dimension", () => {
    const byLabel = { neighbor: "occupied" };
    const config = { neighbor: "occupied" };
    const values = { neighbor: "minecraft:stone" };
    expect(whenMatches(byLabel, config, values)).toBe(true);
    expect(whenMatches({ neighbor: "minecraft:stone" }, config, values)).toBe(true);
    expect(whenMatches({ neighbor: "free" }, config, values)).toBe(false);
  });

  it("treats a list of values as any-of, and a missing when: as every case", () => {
    expect(whenMatches({ face: ["north", "south"] }, { face: "south" }, { face: "south" })).toBe(true);
    expect(whenMatches({ face: ["north", "up"] }, { face: "south" }, { face: "south" })).toBe(false);
    expect(whenMatches(undefined, { face: "south" }, { face: "south" })).toBe(true);
  });

  it("ANDs every matching branch rather than stopping at the first", () => {
    const both = parseStepDocument(
      {
        name: "both",
        matrix: { face: { values: ["north"] } },
        anchors: { chest: "0,64,0" },
        steps: [{ join: {} }],
        expect: [
          { block: { pos: "chest + $face", is: "*_sign" } },
          { when: { face: "north" }, chat: { contains: "placed" } },
        ],
      },
      "both.mctest.yml",
    );
    const selected = selectBranches(both, { face: "north" }, { face: "north" });
    expect(selected.map((s) => s.ref)).toEqual(["both#expect[0]", "both#expect[1]"]);
  });

  it("a when: naming a value no case has selects nothing (the vacuity the §5 lint will flag)", () => {
    expect(selectBranches(test, { face: "north", neighbor: "flooded" }, { face: "north" })).toEqual([]);
  });
});

describe("§4 $dim resolution", () => {
  it("resolves $face into a different asserted position for every case", () => {
    const cases = expandMatrix(parseStepDocument(PLACEMENT, "placement.mctest.yml"));
    const positions = cases.map((c) => {
      const step = c.test.steps.find((s) => s.invariant)!;
      const args = step.args as { x: number; y: number; z: number };
      return `${c.id} → ${args.x},${args.y},${args.z}`;
    });
    expect(positions).toEqual([
      `${CASE_IDS.northFree} → 0,64,-1`,
      `${CASE_IDS.northOccupied} → 0,64,-1`,
      `${CASE_IDS.southFree} → 0,64,1`,
      `${CASE_IDS.southOccupied} → 0,64,1`,
    ]);
  });

  it("substitutes $dim into expected VALUES, not just positions", () => {
    const test = parseStepDocument(
      {
        name: "facing",
        matrix: { face: { values: ["east", "west"] } },
        anchors: { chest: { x: 10, y: 70, z: 10 } },
        steps: [{ join: {} }],
        expect: [{ block: { pos: "chest + $face", is: "*_sign", properties: { facing: "$face" } } }],
      },
      "facing.mctest.yml",
    );
    const [east, west] = expandMatrix(test).map((c) => c.test.steps.find((s) => s.invariant)!);
    expect(east!.args).toMatchObject({ x: 11, y: 70, z: 10, expectProperties: { facing: "east" } });
    expect(west!.args).toMatchObject({ x: 9, y: 70, z: 10, expectProperties: { facing: "west" } });
    expect(east!.invariant!.expected).toContain("facing=east");
  });

  it("resolves anchors, literal triples, face offsets and multi-term arithmetic", () => {
    const anchors = { chest: { x: 0, y: 64, z: 0 } };
    expect(resolvePos("chest", anchors, "at")).toEqual({ x: 0, y: 64, z: 0 });
    expect(resolvePos("0,64,-1", anchors, "at")).toEqual({ x: 0, y: 64, z: -1 });
    expect(resolvePos("chest + up", anchors, "at")).toEqual({ x: 0, y: 65, z: 0 });
    expect(resolvePos("chest - north", anchors, "at")).toEqual({ x: 0, y: 64, z: 1 });
    expect(resolvePos("chest + east + up", anchors, "at")).toEqual({ x: 1, y: 65, z: 0 });
    expect(resolvePos("0,64,-1 + south", anchors, "at")).toEqual({ x: 0, y: 64, z: 0 });
    expect(resolvePos({ x: 1, y: 2, z: 3 }, anchors, "at")).toEqual({ x: 1, y: 2, z: 3 });
  });

  it("names an undeclared anchor instead of guessing a position", () => {
    expect(() => resolvePos("altar + up", { chest: { x: 0, y: 0, z: 0 } }, "expect[0].block")).toThrow(/unknown anchor 'altar'/);
  });
});

describe("§5 the oracle must be well-formed (parse-time refusals)", () => {
  const parse = (expectBlock: unknown, extra: Record<string, unknown> = {}) =>
    parseStepDocument({ name: "t", steps: [{ join: {} }], expect: expectBlock, ...extra }, "t.mctest.yml");

  it("refuses a branch that asserts nothing (it could only pass vacuously)", () => {
    expect(() => parse([{ when: { face: "north" } }])).toThrow(/asserts nothing/);
  });

  it("refuses an unknown clause key rather than silently ignoring it", () => {
    expect(() => parse([{ blocks: { pos: "0,0,0", is: "stone" } }])).toThrow(/unknown key\(s\) blocks/);
    expect(() => parse([{ block: { pos: "0,0,0", isnt: "stone" } }])).toThrow(/unknown key\(s\) isnt/);
  });

  it("names the missing capability for a phase-5 key instead of dropping it", () => {
    expect(() => parse([{ chat: { actor: "Owner", contains: "hi" } }])).toThrow(/multi-actor expectations are spec §9 phase 5/);
  });

  it("refuses a block clause with a position but no expectation, and a pluginState with no expected value", () => {
    expect(() => parse([{ block: { pos: "0,0,0" } }])).toThrow(/asserts nothing/);
    expect(() => parse([{ pluginState: { query: "regions.exists" } }])).toThrow(/needs 'is'/);
  });

  it("refuses an except: override with no written justification", () => {
    expect(() =>
      parse([{ block: { pos: "0,0,0", is: "stone" } }], {
        except: [{ case: "face=north", expect: [{ block: { pos: "0,0,0", is: "air" } }] }],
      }),
    ).toThrow(/needs a written 'reason'/);
  });

  it("refuses an except: that overrides an invariant that does not exist", () => {
    expect(() =>
      parseStepDocument(
        { name: "t", steps: [{ join: {} }], except: [{ case: "x", reason: "y", expect: [{ chat: { contains: "z" } }] }] },
        "t.mctest.yml",
      ),
    ).toThrow(/overrides an 'expect' invariant, but none is declared/);
  });
});

describe("§4 expect: judged against server truth (MockAgent)", () => {
  const cases = expandMatrix(parseStepDocument(PLACEMENT, "placement.mctest.yml"));
  const caseById = (id: string) => cases.find((c) => c.id === id)!.test;

  it("PASSES the cases whose branch the world actually satisfies", async () => {
    // North is walled off, south is open — so the occupied branch judges the north
    // case and the free branch judges the south one, from the SAME invariant.
    const agent = new MockAgent({
      capabilities: ["worldInteraction", "worldTruth", "chat"],
      blocks: { "0,64,0": "minecraft:chest", "0,64,-1": "minecraft:stone" },
      inventory: ["minecraft:oak_sign"],
    });
    const results = await runCases(agent, [caseById(CASE_IDS.northOccupied), caseById(CASE_IDS.southFree)]);

    expect(results.map((r) => r.outcome)).toEqual(["passed", "passed"]);
    expect(results[0]!.invariant).toMatchObject({ ref: "placement#expect[1]" });
    expect(results[0]!.invariant!.expected).toContain("block 0,64,-1 is minecraft:stone");
    expect(results[0]!.invariant!.actual).toContain("face is blocked");
    expect(results[1]!.invariant).toMatchObject({ ref: "placement#expect[0]" });
    expect(results[1]!.invariant!.actual).toContain("minecraft:oak_sign");
  });

  it("FAILS the case the world violates, recording expected vs actual — and calls it fail, not error", async () => {
    // Same wall, but now the case says the neighbour is FREE: the sign cannot land
    // on the clicked face, and the invariant is what notices.
    const agent = new MockAgent({
      capabilities: ["worldInteraction", "worldTruth", "chat"],
      blocks: { "0,64,0": "minecraft:chest", "0,64,-1": "minecraft:stone" },
      inventory: ["minecraft:oak_sign"],
    });
    const results = await runCases(agent, [caseById(CASE_IDS.northFree)]);

    expect(results[0]!.outcome).toBe("failed");
    expect(results[0]!.failure!.type).toBe("INVARIANT_FAILED");
    expect(results[0]!.invariant!.expected).toContain("block 0,64,-1 is *_sign");
    expect(results[0]!.invariant!.actual).toContain("expected *_sign, got minecraft:stone");

    const report = buildResultsReport(results, "mock");
    expect(report.cases[0]).toMatchObject({
      status: "fail",
      invariant_ref: "placement#expect[0]",
    });
    expect(report.cases[0]!.expected).toContain("*_sign");
    expect(report.cases[0]!.actual).toContain("minecraft:stone");
  });

  it("SKIPS a case whose invariant nothing could evaluate — never a silent pass", async () => {
    // The test declares only what its STEPS need, so it is not skipped up front;
    // the driver can act on the world but cannot READ it, so the actions all run
    // and the case is still reported skipped — no oracle read anything.
    const actionsOnly = parseStepDocument(
      { ...PLACEMENT, name: "actions-only", requires: { worldInteraction: true, chat: true } },
      "actions-only.mctest.yml",
    );
    const target = expandMatrix(actionsOnly).find((c) => c.id === CASE_IDS.southFree)!.test;
    const agent = new MockAgent({
      capabilities: ["worldInteraction", "chat"],
      blocks: { "0,64,0": "minecraft:chest" },
      inventory: ["minecraft:oak_sign"],
    });
    const results = await runCases(agent, [target], { worldInteraction: true, chat: true });

    expect(results[0]!.outcome).toBe("skipped");
    expect(results[0]!.skip).toMatchObject({ reason: "INVARIANT_NOT_EVALUATED", unmet: ["worldTruth"] });
    expect(results[0]!.invariant!.actual).toContain("not evaluated");
    const report = buildResultsReport(results, "mock");
    expect(report.cases[0]!.status).toBe("skip");
    expect(report.executed).toBe(0);
    expect(report.declared).toBe(1);
  });
});

describe("§4 except: per-case overrides are honoured AND flagged", () => {
  const test = parseStepDocument(
    {
      ...PLACEMENT,
      name: "placement-with-exception",
      except: [
        {
          case: CASE_IDS.southFree,
          reason: "MC-12345: the south face reports the sign one tick late; tracked, not accepted",
          expect: [{ chat: { contains: "Placed minecraft:oak_sign" } }],
        },
      ],
    },
    "placement-with-exception.mctest.yml",
  );

  it("replaces the shared oracle for the named case only", () => {
    const overridden = compileInvariantSteps(test, { face: "south", neighbor: "free" }, { face: "south", neighbor: null }, CASE_IDS.southFree);
    expect(overridden).toHaveLength(1);
    expect(overridden[0]!.invariant).toMatchObject({
      ref: "placement-with-exception#except[0].expect[0]",
      exception: expect.stringContaining("MC-12345"),
    });
    const untouched = compileInvariantSteps(test, { face: "north", neighbor: "free" }, { face: "north", neighbor: null }, CASE_IDS.northFree);
    expect(untouched[0]!.invariant!.ref).toBe("placement-with-exception#expect[0]");
    expect(untouched[0]!.invariant!.exception).toBeUndefined();
  });

  it("flags the exception on the case in results.json", async () => {
    const cases = expandMatrix(test);
    const agent = new MockAgent({
      capabilities: ["worldInteraction", "worldTruth", "chat"],
      blocks: { "0,64,0": "minecraft:chest" },
      inventory: ["minecraft:oak_sign"],
    });
    const results = await runCases(agent, [cases.find((c) => c.id === CASE_IDS.southFree)!.test]);

    expect(results[0]!.outcome).toBe("passed");
    // …and loudly, wherever a human reads the run — not only in the JSON.
    expect(results[0]!.notes!.join("\n")).toContain("PER-CASE EXCEPTION");
    const report = buildResultsReport(results, "mock");
    expect(report.cases[0]!.exception).toContain("except[0]: MC-12345");
    expect(report.cases[0]!.invariant_ref).toBe("placement-with-exception#except[0].expect[0]");
  });
});

describe("§6 declared universe vs executed subset", () => {
  const pairwise = parseStepDocument(
    {
      name: "pairwise",
      matrix: {
        face: { values: ["north", "south"] },
        held: { values: { empty: null, sign: "oak_sign" } },
        neighbor: { values: { free: null, occupied: "stone" } },
      },
      coverage: "pairwise",
      steps: [{ chat: "case $face/$held/$neighbor" }],
    },
    "pairwise.mctest.yml",
  );

  it("counts the FULL cross-product as declared, whatever coverage model ran", () => {
    expect(declaredCaseCount(pairwise)).toBe(8);
    expect(expandMatrix(pairwise).length).toBeLessThan(8);
  });

  it("reports declared != executed on a pairwise run rather than a flattering 100%", () => {
    const cases = expandMatrix(pairwise);
    const results = cases.map((c) => ({
      name: c.test.name,
      target: "mock",
      outcome: "passed" as const,
      durationMs: 1,
      steps: [],
      matrixCase: { id: c.id, config: c.config, coverage: c.coverage, environmentKey: c.environmentKey },
    }));
    const report = buildResultsReport(results, "mock", undefined, { declared: declaredCaseCount(pairwise) });

    expect(report.coverage_model).toBe("pairwise");
    expect(report.declared).toBe(8);
    expect(report.executed).toBe(cases.length);
    expect(report.executed).toBeLessThan(report.declared);
  });

  it("a flat (matrix-less) test declares exactly one case", () => {
    expect(declaredCaseCount(parseStepDocument({ name: "flat", steps: [{ join: {} }] }, "flat.mctest.yml"))).toBe(1);
  });
});

describe("the flat path judges an invariant too", () => {
  const flat = parseStepDocument(
    {
      name: "flat-oracle",
      requires: { worldTruth: true },
      anchors: { chest: "0,64,0" },
      steps: [{ join: {} }],
      expect: [{ block: { pos: "chest + up", is: "*_sign" } }],
    },
    "flat-oracle.mctest.yml",
  );

  it("appends the oracle to a test with an expect: but no matrix:", () => {
    const judged = applyInvariants(flat);
    expect(judged.steps.filter((s) => s.invariant)).toHaveLength(1);
    expect(judged.steps.at(-1)!.args).toMatchObject({ x: 0, y: 65, z: 0, expect: "*_sign" });
  });

  it("never double-judges a case whose oracle expansion already compiled", () => {
    expect(applyInvariants(applyInvariants(flat)).steps.filter((s) => s.invariant)).toHaveLength(1);
    const expanded = expandMatrix(parseStepDocument(PLACEMENT, "placement.mctest.yml"))[0]!.test;
    expect(applyInvariants(expanded).steps.filter((s) => s.invariant)).toHaveLength(1);
  });
});
