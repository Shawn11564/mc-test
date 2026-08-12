/**
 * Structured `results.json`, written beside the JUnit XML (docs/CI.md; spec
 * commandcenter/40-testing-loop.md §6). Where JUnit exists for CI dashboards that
 * already speak that format, results.json is the TYPED artifact other tools (the
 * CC Testing module — spec §9 phase 3) parse instead of scraping XML/console text.
 *
 * A "case" is one (test x target) cell, or — for a parameterized test — one
 * (matrix case x target) cell whose `config` carries the bound dimension values.
 * With the `expect:` invariant DSL (spec §4-§5) a case also carries the oracle's
 * verdict: `expected` / `actual` / `invariant_ref`, and `exception` when a
 * per-case `except:` override judged it instead of the shared invariant.
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
  /**
   * Set when a per-case `except:` override replaced the shared invariant for
   * this case (spec §4: allowed, but visually flagged — exceptions are where
   * circular oracles sneak back in). Carries the authored justification.
   */
  exception?: string;
}

/** A static §5.3 finding about the run's tests (vacuous branch / dead dimension). */
export interface ResultLint {
  rule: string;
  ref: string;
  message: string;
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
  /**
   * Static lint findings (spec §5.3). Carried in the report — not just printed —
   * so a vacuous branch renders like a skip in the coverage web instead of
   * silently inflating the completeness bar.
   */
  lints?: ResultLint[];
}

/** Run-level facts the reporter cannot derive from the results alone. */
export interface ResultsReportOptions {
  /**
   * The DECLARED universe (spec §4/§7): the full cross-product the run's tests
   * declare. Only the caller knows what was expanded; absent, it falls back to
   * the case count (a flat run declares exactly what it produced).
   */
  declared?: number;
  /** Static §5.3 findings for the tests in this run. */
  lints?: ResultLint[];
}

/**
 * pass|fail|error|skip per spec §4. A broken `expect:` branch is the canonical
 * `fail` — the steps ran and the EXPECTATION gave way (the runner stamps
 * `INVARIANT_FAILED`). A whole-test exception or a provisioning failure means the
 * run never got a clean read on any expectation → `error`. Any other step-level
 * outcome (an MCTP primitive/assertion result) is a `fail`.
 */
function classifyStatus(outcome: Outcome, failureType: string | undefined): CaseStatus {
  if (outcome === "skipped") return "skip";
  if (outcome === "passed") return "pass";
  if (failureType === "INVARIANT_FAILED") return "fail";
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
    // The oracle's verdict, when the test declared one (spec §5–§6). Written on
    // every status, not just failures: a pass that cannot say WHAT it proved is
    // the circular-oracle failure mode in miniature.
    ...(r.invariant
      ? {
          expected: r.invariant.expected,
          actual: r.invariant.actual,
          invariant_ref: r.invariant.ref,
          ...(r.invariant.exception ? { exception: r.invariant.exception } : {}),
        }
      : {}),
    evidence: r.artifacts ?? [],
    ...(r.skip ? { skip_reason: `${r.skip.reason} — ${r.skip.message}` } : {}),
  };
}

/**
 * Aggregate a set of `TestResult`s into the run-level totals + per-case array.
 *
 * `executed` counts cases that actually ran steps: a skip is
 * declared-but-not-executed and counts AGAINST completeness (spec §4), never
 * toward it.
 */
export function buildResultsReport(
  results: TestResult[],
  targets: string,
  sha?: string,
  options: ResultsReportOptions = {},
): ResultsReport {
  const { declared, lints } = options;
  const cases = results.map(toResultCase);
  const passed = cases.filter((c) => c.status === "pass").length;
  const failed = cases.filter((c) => c.status === "fail").length;
  const errored = cases.filter((c) => c.status === "error").length;
  const skipped = cases.filter((c) => c.status === "skip").length;
  return {
    declared: Math.max(declared ?? cases.length, cases.length),
    executed: passed + failed + errored,
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
    ...(lints?.length ? { lints } : {}),
  };
}

/** Render and write `results.json` to disk. */
export function writeResults(
  path: string,
  results: TestResult[],
  targets: string,
  sha?: string,
  options: ResultsReportOptions = {},
): void {
  mkdirSync(dirname(path), { recursive: true });
  const report = buildResultsReport(results, targets, sha, options);
  writeFileSync(path, JSON.stringify(report, null, 2), "utf8");
}
