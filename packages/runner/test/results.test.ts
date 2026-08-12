/**
 * results.json (spec commandcenter/40-testing-loop.md §6): a real run's aggregated
 * results must validate against `schema/results.schema.json`, and the run-level
 * totals must be consistent with the per-case statuses — no case silently
 * uncounted, no fabricated pass.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import { buildResultsReport, writeResults, type ResultsReport } from "../src/index.js";
import type { TestResult } from "../src/model/result.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const schemaPath = join(here, "..", "schema", "results.schema.json");
const schema = JSON.parse(readFileSync(schemaPath, "utf8"));

function validator() {
  const ajv = new Ajv({ strict: false, allErrors: true });
  return ajv.compile(schema);
}

function expectValid(data: unknown): void {
  const validate = validator();
  const ok = validate(data);
  if (!ok) {
    throw new Error(`results.json should validate but did not:\n${JSON.stringify(validate.errors, null, 2)}`);
  }
}

const PASSED: TestResult = {
  name: "regions-open-testregion",
  target: "paper-1.21.1",
  loader: "paper",
  mc: "1.21.1",
  driver: "headless",
  outcome: "passed",
  durationMs: 1234,
  steps: [{ index: 0, verb: "join", outcome: "passed", durationMs: 100 }],
};

const FAILED: TestResult = {
  name: "regions-open-testregion",
  target: "fabric-1.21.1",
  loader: "fabric",
  mc: "1.21.1",
  driver: "inprocess",
  outcome: "failed",
  durationMs: 5000,
  steps: [
    { index: 0, verb: "join", outcome: "passed", durationMs: 100 },
    {
      index: 1,
      verb: "assertChat",
      outcome: "failed",
      durationMs: 200,
      error: { message: "chat did not contain 'Region loaded'", reason: "ASSERT_FAILED" },
    },
  ],
  failure: { message: "step 1 (assertChat) failed: chat did not contain 'Region loaded'", type: "ASSERT_FAILED" },
  artifacts: ["mc-test-report/artifacts/fabric-1.21.1/regions-open-testregion/failure-step1.png"],
};

const PROVISION_ERROR: TestResult = {
  name: "regions-open-testregion",
  target: "neoforge-1.21.1",
  outcome: "failed",
  durationMs: 0,
  steps: [],
  failure: { message: "MOD_NOT_LOADED: OpenRegions not found in the neoforge boot log", type: "ProvisionError" },
};

const SKIPPED: TestResult = {
  name: "regions-open-testregion",
  target: "old-legacy-1.7.10",
  outcome: "skipped",
  durationMs: 0,
  steps: [],
  skip: {
    category: "capability",
    reason: "NO_COMPATIBLE_DRIVER",
    unmet: ["clientScreens"],
    message: "no driver satisfies required capabilities {clientScreens}",
  },
};

const RESULTS = [PASSED, FAILED, PROVISION_ERROR, SKIPPED];

describe("results.json — schema conformance", () => {
  it("a real (mixed pass/fail/error/skip) run validates against the schema", () => {
    const report = buildResultsReport(RESULTS, "paper-1.21.1,fabric-1.21.1,neoforge-1.21.1,old-legacy-1.7.10");
    expectValid(report);
  });

  it("an empty run still validates", () => {
    expectValid(buildResultsReport([], "paper-1.21.1"));
  });
});

describe("results.json — case mapping", () => {
  const report: ResultsReport = buildResultsReport(RESULTS, "irrelevant-for-this-block");

  it("counts a skip as DECLARED but not EXECUTED (a skip counts against coverage, spec §4)", () => {
    expect(report.declared).toBe(4);
    expect(report.executed).toBe(3);
  });

  it("classifies a passed test as pass", () => {
    const c = report.cases.find((c) => c.id === "regions-open-testregion@paper-1.21.1")!;
    expect(c.status).toBe("pass");
    expect(c.ms).toBe(1234);
  });

  it("classifies a step-level failure as fail, recording the failed step + evidence", () => {
    const c = report.cases.find((c) => c.id === "regions-open-testregion@fabric-1.21.1")!;
    expect(c.status).toBe("fail");
    expect(c.failed_step).toBe("1:assertChat");
    expect(c.evidence).toEqual(FAILED.artifacts);
  });

  it("classifies a ProvisionError (infra never ran the test) as error, not fail", () => {
    const c = report.cases.find((c) => c.id === "regions-open-testregion@neoforge-1.21.1")!;
    expect(c.status).toBe("error");
  });

  it("classifies an honest skip as skip, carrying the reason", () => {
    const c = report.cases.find((c) => c.id === "regions-open-testregion@old-legacy-1.7.10")!;
    expect(c.status).toBe("skip");
    expect(c.skip_reason).toContain("NO_COMPATIBLE_DRIVER");
  });

  it("run-level totals sum to the case count and match per-case statuses", () => {
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.errored).toBe(1);
    expect(report.skipped).toBe(1);
    expect(report.passed + report.failed + report.errored + report.skipped).toBe(report.cases.length);
  });
});

describe("results.json — file write", () => {
  it("writes a file that round-trips through JSON.parse and validates", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-test-results-"));
    const path = join(dir, "results.json");
    writeResults(path, RESULTS, "paper-1.21.1,fabric-1.21.1,neoforge-1.21.1,old-legacy-1.7.10", "deadbeef");
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expectValid(parsed);
    expect(parsed.sha).toBe("deadbeef");
    expect(parsed.cases).toHaveLength(4);
  });

  it("carries the invariant verdict + exception flag of a matrix case, and still validates", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-test-results-"));
    const path = join(dir, "results.json");
    const judged: TestResult = {
      ...PASSED,
      name: "placement",
      outcome: "failed",
      failure: { message: "step 1000 (getBlock) failed", type: "INVARIANT_FAILED" },
      steps: [{ index: 1000, verb: "getBlock", outcome: "failed", durationMs: 5 }],
      matrixCase: { id: "face=north,neighbor=free", config: { face: "north", neighbor: "free" }, coverage: "pairwise", environmentKey: "" },
      invariant: {
        ref: "placement#except[0].expect[0]",
        expected: "block 0,64,-1 is *_sign",
        actual: "block assertion failed at 0,64,-1: expected *_sign, got minecraft:stone",
        exception: "except[0]: MC-12345 — tracked, not accepted",
      },
    };
    // declared (8) > executed (1): a pairwise run must never claim the whole universe.
    writeResults(path, [judged], "paper-1.21.1", "deadbeef", {
      declared: 8,
      lints: [{ rule: "dead-dimension", ref: "placement#matrix.held", message: "held is theater" }],
    });
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expectValid(parsed);
    expect(parsed.declared).toBe(8);
    expect(parsed.executed).toBe(1);
    expect(parsed.coverage_model).toBe("pairwise");
    expect(parsed.cases[0]).toMatchObject({
      id: "placement[face=north,neighbor=free]@paper-1.21.1",
      status: "fail",
      failed_step: "1000:getBlock",
      expected: "block 0,64,-1 is *_sign",
      invariant_ref: "placement#except[0].expect[0]",
      exception: "except[0]: MC-12345 — tracked, not accepted",
    });
    expect(parsed.cases[0].config).toMatchObject({ face: "north", neighbor: "free" });
    // §5.3 lints ride along in the report, so the coverage web can render them.
    expect(parsed.lints).toEqual([
      { rule: "dead-dimension", ref: "placement#matrix.held", message: "held is theater" },
    ]);
  });

  it("omits sha entirely rather than writing null/empty when unavailable", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-test-results-"));
    const path = join(dir, "results.json");
    writeResults(path, [PASSED], "paper-1.21.1");
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect("sha" in parsed).toBe(false);
    expectValid(parsed);
  });
});
