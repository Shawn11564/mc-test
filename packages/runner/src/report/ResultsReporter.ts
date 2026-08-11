/**
 * Structured `results.json`, written beside the JUnit XML (docs/CI.md; spec
 * commandcenter/40-testing-loop.md §6). Where JUnit exists for CI dashboards that
 * already speak that format, results.json is the TYPED artifact other tools (the
 * CC Testing module — spec §9 phase 3) parse instead of scraping XML/console text.
 *
 * A "case" here is one (test x target) cell — the matrix engine (spec §4, phase 2)
 * will later expand `config` with per-dimension bound values and distinguish
 * `fail` (an expectation broke) from `error` (a step itself broke) via the
 * invariant DSL. Until then this reporter derives a best-effort status from the
 * existing `TestResult`/`StepResult` model (see {@link classifyStatus}) — it is an
 * honest approximation, not the final invariant-aware verdict.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Outcome, StepResult, TestResult } from "../model/result.js";

export type CaseStatus = "pass" | "fail" | "error" | "skip";

export interface ResultCase {
  id: string;
  config: Record<string, unknown>;
  status: CaseStatus;
  ms: number;
  failed_step?: string;
  expected?: string;
  actual?: string;
  evidence: string[];
  skip_reason?: string;
  invariant_ref?: string;
}

export interface ResultsReport {
  declared: number;
  executed: number;
  passed: number;
  failed: number;
  errored: number;
  skipped: number;
  coverage_model: string;
  target: string;
  sha?: string;
  cases: ResultCase[];
}

/**
 * Best-effort pass|fail|error|skip classification from the current (pre-matrix-engine)
 * `TestResult` model, which only tracks passed|failed|skipped and does not yet carry
 * the invariant-DSL distinction between "an expectation broke" (fail) and "a step
 * itself broke" (error) (spec §4). Heuristic: a whole-test exception or a provisioning
 * failure means the run never got a clean read on any expectation → `error`; a specific
 * step outcome (an MCTP-level primitive/assertion result) → `fail`. Revisit once the
 * matrix engine's `expect:` DSL lands (spec §9 phase 2).
 */
function classifyStatus(outcome: Outcome, failureType: string | undefined): CaseStatus {
  if (outcome === "skipped") return "skip";
  if (outcome === "passed") return "pass";
  if (failureType === "ProvisionError" || failureType === "Error") return "error";
  return "fail";
}

function failedStepOf(steps: StepResult[]): StepResult | undefined {
  return steps.find((s) => s.outcome === "failed");
}

/** Build one report case from a `TestResult`. */
export function toResultCase(r: TestResult): ResultCase {
  const status = classifyStatus(r.outcome, r.failure?.type);
  const failedStep = status === "fail" || status === "error" ? failedStepOf(r.steps) : undefined;
  const config: Record<string, unknown> = { target: r.target, ...(r.matrixCase?.config ?? {}) };
  if (r.loader) config["loader"] = r.loader;
  if (r.mc) config["mc"] = r.mc;
  if (r.driver) config["driver"] = r.driver;

  return {
    id: r.matrixCase ? `${r.name}[${r.matrixCase.id}]@${r.target}` : `${r.name}@${r.target}`,
    config,
    status,
    ms: r.durationMs,
    ...(failedStep ? { failed_step: `${failedStep.index}:${failedStep.verb}` } : {}),
    evidence: r.artifacts ?? [],
    ...(r.skip ? { skip_reason: `${r.skip.reason} — ${r.skip.message}` } : {}),
  };
}

/** Aggregate a set of `TestResult`s into the run-level totals + per-case array. */
export function buildResultsReport(results: TestResult[], targets: string, sha?: string): ResultsReport {
  const cases = results.map(toResultCase);
  const passed = cases.filter((c) => c.status === "pass").length;
  const failed = cases.filter((c) => c.status === "fail").length;
  const errored = cases.filter((c) => c.status === "error").length;
  const skipped = cases.filter((c) => c.status === "skip").length;
  return {
    // No matrix engine yet (spec §9 phase 2): every declared case is executed, one
    // case per (test x target) — never "declared but not run" (that distinction is
    // the matrix engine's; a flat run can't yet skip a case before starting it).
    declared: cases.length,
    executed: cases.length,
    passed,
    failed,
    errored,
    skipped,
    coverage_model: results.some((result) => result.matrixCase?.coverage === "pairwise")
      ? "pairwise"
      : results.some((result) => result.matrixCase?.coverage === "full")
        ? "full"
        : "flat",
    target: targets,
    ...(sha ? { sha } : {}),
    cases,
  };
}

/** Render and write `results.json` to disk. */
export function writeResults(path: string, results: TestResult[], targets: string, sha?: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const report = buildResultsReport(results, targets, sha);
  writeFileSync(path, JSON.stringify(report, null, 2), "utf8");
}
