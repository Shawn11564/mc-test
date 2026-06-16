/**
 * The cross-target **skip matrix** (ROADMAP §6.3): a `(test × target)` grid that
 * makes coverage gaps visible — which cells ran, which were skipped (and why, as
 * machine-readable capability reason strings), and which ran on a brittle
 * last-resort driver. The JUnit report (`JUnitReporter`) emits per-cell
 * `<skipped>`; this is the human-facing aggregate pivoted across the whole matrix
 * so a glance shows the shape of what was and wasn't exercised.
 *
 * Pure functions over the `TestResult[]` the engine already produces — no new
 * state. A skipped or partially-skipped cell carries the **union** of every unmet
 * capability key (test-level `skip.unmet` ∪ each step's `skip.unmet`), so the
 * reasons are the same canonical capability tokens used everywhere else.
 */
import type { Outcome, TestResult } from "../model/result.js";

/** One `(test × target)` cell. */
export interface SkipCell {
  test: string;
  target: string;
  outcome: Outcome;
  /** True when a passing/failing test still had ≥1 honestly-skipped step. */
  hasStepSkips: boolean;
  /** Distinct skip reason tokens (e.g. `NO_COMPATIBLE_DRIVER`), test- + step-level. */
  reasons: string[];
  /** Union of every unmet capability key (test- + step-level), deduped + sorted. */
  unmet: string[];
  /** The cell ran on a brittle last-resort (pixel/OCR) driver. */
  brittle: boolean;
}

/** The pivoted matrix: sorted axes + the populated cells + a lookup. */
export interface SkipMatrix {
  tests: string[];
  targets: string[];
  cells: SkipCell[];
  /** The cell for `(test, target)`, or `undefined` if that pair was not run. */
  get(test: string, target: string): SkipCell | undefined;
}

function uniqSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

/**
 * Composite lookup key. Uses `JSON.stringify([test, target])` so the two
 * components are unambiguously bracketed and quoted — two distinct `(test,
 * target)` pairs can never collide into one entry (a plain-string join with a
 * single delimiter could, if a test name contained that delimiter).
 */
function cellKey(test: string, target: string): string {
  return JSON.stringify([test, target]);
}

/** Pivot a flat `TestResult[]` into the `(test × target)` skip matrix. */
export function buildSkipMatrix(results: TestResult[]): SkipMatrix {
  const cells: SkipCell[] = results.map((r) => {
    const reasons = new Set<string>();
    const unmet = new Set<string>();
    if (r.skip) {
      reasons.add(r.skip.reason);
      for (const k of r.skip.unmet) unmet.add(k);
    }
    let hasStepSkips = false;
    for (const s of r.steps) {
      if (s.outcome === "skipped" && s.skip) {
        hasStepSkips = true;
        reasons.add(s.skip.reason);
        for (const k of s.skip.unmet) unmet.add(k);
      }
    }
    return {
      test: r.name,
      target: r.target,
      outcome: r.outcome,
      hasStepSkips,
      reasons: [...reasons].sort((a, b) => a.localeCompare(b)),
      unmet: [...unmet].sort((a, b) => a.localeCompare(b)),
      brittle: r.brittle === true,
    };
  });

  const tests = uniqSorted(cells.map((c) => c.test));
  const targets = uniqSorted(cells.map((c) => c.target));
  const index = new Map(cells.map((c) => [cellKey(c.test, c.target), c]));

  return {
    tests,
    targets,
    cells,
    get: (test, target) => index.get(cellKey(test, target)),
  };
}

/** The single-character status glyph for a cell (`undefined` = not run). */
function glyph(cell: SkipCell | undefined): string {
  if (!cell) return "·"; // (test × target) pair not run
  if (cell.outcome === "skipped") return "○"; // honest whole-test skip
  if (cell.outcome === "failed") return "✗";
  // passed — but flag a brittle driver (loudest signal) or a partially-skipped pass.
  if (cell.brittle) return "!"; // passed on the brittle last-resort driver
  if (cell.hasStepSkips) return "◐"; // passed with ≥1 honestly-skipped step
  return "✓";
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

/**
 * Render the skip matrix as a fixed-width text grid + a legend and a per-cell
 * reason list. Rows are tests, columns are targets; the legend explains every
 * glyph and the reasons section spells out each skipped/partial/brittle cell with
 * its capability reason strings. The reason headline uses the SAME brittle >
 * step-skip precedence as the grid glyph, so the two never disagree.
 */
export function renderSkipMatrix(results: TestResult[]): string {
  const m = buildSkipMatrix(results);
  if (m.cells.length === 0) return "Skip matrix: (no results)";

  const testColWidth = Math.max(4, ...m.tests.map((t) => t.length));
  const colWidth = m.targets.map((t) => Math.max(3, t.length));

  const header = `${pad("test", testColWidth)} │ ${m.targets.map((t, i) => pad(t, colWidth[i]!)).join(" │ ")}`;
  const rule = `${"─".repeat(testColWidth)}─┼─${colWidth.map((w) => "─".repeat(w)).join("─┼─")}`;
  const rows = m.tests.map((test) => {
    const cells = m.targets.map((target, i) => pad(glyph(m.get(test, target)), colWidth[i]!));
    return `${pad(test, testColWidth)} │ ${cells.join(" │ ")}`;
  });

  // Per-cell reasons for everything that didn't cleanly pass on a structural driver.
  const reasonLines: string[] = [];
  for (const cell of m.cells) {
    const noteworthy = cell.outcome !== "passed" || cell.hasStepSkips || cell.brittle;
    if (!noteworthy) continue;
    const bits: string[] = [];
    if (cell.outcome === "skipped") bits.push("SKIPPED");
    else if (cell.outcome === "failed") bits.push("FAILED");
    // Passed: lead with brittle (matches the glyph's '!' precedence), but keep the
    // step-skip detail so nothing is lost for a cell that is both.
    else if (cell.brittle) bits.push(cell.hasStepSkips ? "PASSED (brittle; some steps skipped)" : "PASSED (brittle)");
    else if (cell.hasStepSkips) bits.push("PASSED (some steps skipped)");
    if (cell.brittle) bits.push("brittle-driver");
    if (cell.reasons.length) bits.push(cell.reasons.join("+"));
    if (cell.unmet.length) bits.push(`unmet:[${cell.unmet.join(",")}]`);
    reasonLines.push(`  ${cell.test} × ${cell.target}: ${bits.join(" ")}`);
  }

  const legend =
    "legend: ✓ passed   ◐ passed (some steps skipped)   ○ skipped   ✗ failed   ! passed on brittle driver   · not run";

  return [
    "Skip matrix (test × target):",
    "",
    header,
    rule,
    ...rows,
    "",
    legend,
    ...(reasonLines.length ? ["", "reasons:", ...reasonLines] : []),
  ].join("\n");
}
