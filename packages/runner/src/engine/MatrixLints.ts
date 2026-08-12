/**
 * Static matrix/invariant lints (spec commandcenter/40-testing-loop.md §5.3).
 *
 * These run at EXPANSION time — before anything boots — and answer the two ways a
 * matrix can look like coverage while proving nothing:
 *
 *  - **vacuous branch**: an `expect:`/`except:` entry whose `when:` selects zero
 *    generated cases. It is dead text: it can never fail, so it can never judge.
 *  - **dead dimension**: a dimension whose values reach no expectation. The run
 *    varies the input N ways and asserts the same thing every time, so the extra
 *    cases are theater — the exact shape the Aug-4 review found in the fleet.
 *
 * They are WARNINGS, not failures: an author mid-edit shouldn't be blocked. But
 * they are surfaced on the console AND carried into results.json (`lints`), so a
 * vacuous branch renders like a skip in the coverage web rather than silently
 * inflating a completeness bar (spec §5.3, §7).
 */
import type { NormalizedTest } from "../model/Step.js";
import type { MatrixCase } from "./MatrixExpansion.js";
import { declaredCases } from "./MatrixExpansion.js";
import { whenMatches, type ExpectBranch } from "./Invariants.js";

export type MatrixLintRule = "vacuous-branch" | "dead-dimension";

/** One static finding about a test's matrix/invariant pair. */
export interface MatrixLint {
  rule: MatrixLintRule;
  /** `<test>#expect[1]`, `<test>#except[0]`, or `<test>#matrix.held`. */
  ref: string;
  message: string;
}

/**
 * Authored verbs that produce a VERDICT. A dimension referenced only by an action
 * (`useBlock`, `setHeldItem`, …) changes what happens but not what is judged —
 * which is precisely the dead-dimension smell.
 */
const ASSERTION_VERBS = new Set<string>([
  "assertChat",
  "waitForChat",
  "getBlock",
  "waitForBlock",
  "getContainer",
  "getItem",
  "getEntities",
  "assertPluginState",
  "waitForPluginState",
]);

/** Every `$name` token appearing anywhere inside a JSON value. */
function tokensIn(value: unknown, into: Set<string>): void {
  if (typeof value === "string") {
    for (const match of value.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)) into.add(match[1]!);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) tokensIn(entry, into);
    return;
  }
  if (value && typeof value === "object") {
    for (const entry of Object.values(value as Record<string, unknown>)) tokensIn(entry, into);
  }
}

/** Dimension names an expectation actually consumes — via `when:` or a `$dim` token. */
function referencedByExpectations(test: NormalizedTest): Set<string> {
  const referenced = new Set<string>();
  const walk = (branches: ExpectBranch[]): void => {
    for (const branch of branches) {
      for (const key of Object.keys(branch.when ?? {})) referenced.add(key);
      for (const clause of branch.clauses) tokensIn(clause.spec, referenced);
    }
  };
  walk(test.expect ?? []);
  for (const entry of test.except ?? []) {
    for (const key of Object.keys(entry.when ?? {})) referenced.add(key);
    walk(entry.branches);
  }
  // A test with no `expect:` still judges through its authored assertion steps;
  // a dimension woven into one of those is constraining an expectation too.
  for (const step of test.steps) {
    if (ASSERTION_VERBS.has(step.verb)) tokensIn(step.args, referenced);
  }
  return referenced;
}

/** `expect[i]` / `except[i]` entries paired with the ref a report cites. */
function branchesWithRefs(test: NormalizedTest): Array<{ ref: string; when?: Record<string, unknown>; kind: string }> {
  return [
    ...(test.expect ?? []).map((branch, i) => ({
      ref: `${test.name}#expect[${i}]`,
      ...(branch.when ? { when: branch.when } : {}),
      kind: "expect branch",
    })),
    ...(test.except ?? []).map((entry, i) => ({
      ref: `${test.name}#except[${i}]`,
      ...(entry.when ? { when: entry.when } : {}),
      kind: "except override",
    })),
  ];
}

/**
 * Lint one test against the cases it actually generated. `cases` is what will
 * run (a pairwise subset, when that is the coverage model); the declared
 * cross-product is recomputed here so the message can tell "this branch is dead"
 * apart from "pairwise dropped the cases it would have judged".
 */
export function lintMatrix(test: NormalizedTest, cases: MatrixCase[]): MatrixLint[] {
  const lints: MatrixLint[] = [];
  const dimensions = Object.keys(test.matrix ?? {});
  const declared = dimensions.length ? declaredCases(test) : [];

  for (const branch of branchesWithRefs(test)) {
    // A branch with no `when:` judges every case; only a filtered one can be vacuous.
    if (!branch.when) continue;
    const generatedHits = cases.filter((c) => whenMatches(branch.when, c.config, c.values)).length;
    if (generatedHits > 0) continue;
    const declaredHits = declared.filter((c) => whenMatches(branch.when, c.config, c.values)).length;
    const unknown = Object.keys(branch.when).filter((key) => dimensions.length > 0 && !dimensions.includes(key));
    const why = unknown.length
      ? `its when: names ${unknown.map((k) => `'${k}'`).join(", ")}, which ${unknown.length > 1 ? "are" : "is"} not a dimension of this matrix`
      : declaredHits > 0
        ? `it would judge ${declaredHits} declared case(s), but coverage: ${test.coverage ?? "full"} generated none of them`
        : dimensions.length === 0
          ? "the test declares no matrix:, so no case can carry those dimension values"
          : "no combination of the declared values satisfies it";
    lints.push({
      rule: "vacuous-branch",
      ref: branch.ref,
      message:
        `VACUOUS ${branch.kind}: matches 0 of ${cases.length} generated case(s) — ${why}. ` +
        `A branch nothing selects can never fail, so it judges nothing (spec §5.3).`,
    });
  }

  if (dimensions.length) {
    const referenced = referencedByExpectations(test);
    for (const name of dimensions) {
      // An `environment`-bound dimension varies the WORLD the invariant is proved
      // in, not the expectation itself — the same oracle holding across Paper and
      // Fabric is the point, so its absence from `expect:` is correct, not theater.
      if (test.matrix![name]!.bind?.environment) continue;
      if (referenced.has(name)) continue;
      const values = test.matrix![name]!.values;
      const count = Array.isArray(values) ? values.length : Object.keys(values ?? {}).length;
      lints.push({
        rule: "dead-dimension",
        ref: `${test.name}#matrix.${name}`,
        message:
          `DEAD DIMENSION '${name}': ${count} value(s) are varied but no expectation depends on it — ` +
          `every case asserts the same thing, so its values are theater (spec §5.3). ` +
          `Reference it (when: { ${name}: … } or $${name}) or drop it.`,
      });
    }
  }

  return lints;
}

/** Render lints for the console, grouped and prefixed like the preflight warnings. */
export function renderLints(lints: MatrixLint[]): string {
  return [
    "Matrix lints (spec §5.3 — these parts of the test judge nothing):",
    ...lints.map((lint) => `  ! ${lint.rule}  ${lint.ref}: ${lint.message}`),
  ].join("\n");
}
