/**
 * Self-contained HTML report (F5). A single static file (inline CSS, no JS, no deps)
 * with run totals, the `(test × target)` skip matrix, and a per-test step timeline.
 * JUnit XML stays the machine/CI contract; this is the human-friendly view.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { StepResult, TestResult } from "../model/result.js";
import { buildSkipMatrix } from "./SkipMatrix.js";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

function badge(outcome: string): string {
  return `<span class="badge ${outcome}">${outcome}</span>`;
}

function stepRow(s: StepResult): string {
  const glyph = s.outcome === "passed" ? "✓" : s.outcome === "skipped" ? "○" : "✗";
  let detail = "";
  if (s.outcome === "skipped" && s.skip) {
    detail = `SKIPPED ${esc(s.skip.reason)} unmet:[${esc(s.skip.unmet.join(","))}]`;
  } else if (s.outcome === "failed") {
    detail = `FAILED ${esc(s.error?.reason ?? "")} ${esc(s.error?.message ?? "")}`.trim();
  } else if (s.detail) {
    detail = esc(s.detail);
  }
  return `<li class="step ${s.outcome}"><span class="g">${glyph}</span> <code>${esc(s.verb)}</code> <span class="d">${detail}</span></li>`;
}

function testCard(r: TestResult): string {
  const meta = [r.target, r.loader, r.mc, r.driver ? `driver=${r.driver}` : null]
    .filter(Boolean)
    .map((x) => esc(String(x)))
    .join(" · ");
  const notes = (r.notes ?? []).map((n) => `<p class="note">${esc(n)}</p>`).join("");
  const skip = r.skip ? `<p class="note">${esc(r.skip.reason)}: ${esc(r.skip.message)}</p>` : "";
  const fail = r.failure ? `<p class="note">${esc(r.failure.type)}: ${esc(r.failure.message)}</p>` : "";
  const steps = r.steps.length ? `<ul class="steps">${r.steps.map(stepRow).join("")}</ul>` : "";
  return `<section class="card ${r.outcome}">
    <header><h3>${esc(r.name)} ${badge(r.outcome)}</h3><span class="meta">${meta} · ${secs(r.durationMs)}</span></header>
    ${notes}${skip}${fail}${steps}
  </section>`;
}

function matrixTable(results: TestResult[]): string {
  const m = buildSkipMatrix(results);
  if (m.cells.length === 0) return "";
  const glyph = (test: string, target: string): string => {
    const c = m.get(test, target);
    if (!c) return `<td class="cell none">·</td>`;
    if (c.outcome === "skipped") return `<td class="cell skipped" title="${esc(c.reasons.join("+"))}">○</td>`;
    if (c.outcome === "failed") return `<td class="cell failed">✗</td>`;
    if (c.brittle) return `<td class="cell brittle">!</td>`;
    if (c.hasStepSkips) return `<td class="cell partial" title="some steps skipped">◐</td>`;
    return `<td class="cell passed">✓</td>`;
  };
  const head = `<tr><th>test \\ target</th>${m.targets.map((t) => `<th>${esc(t)}</th>`).join("")}</tr>`;
  const rows = m.tests
    .map((t) => `<tr><th class="rowname">${esc(t)}</th>${m.targets.map((tg) => glyph(t, tg)).join("")}</tr>`)
    .join("");
  return `<h2>Skip matrix</h2><table class="matrix">${head}${rows}</table>
    <p class="legend">✓ passed · ◐ passed (steps skipped) · ○ skipped · ✗ failed · ! brittle · · not run</p>`;
}

/** Render the full HTML report document. */
export function renderHtml(results: TestResult[]): string {
  const total = results.length;
  const passed = results.filter((r) => r.outcome === "passed").length;
  const failed = results.filter((r) => r.outcome === "failed").length;
  const skipped = results.filter((r) => r.outcome === "skipped").length;
  const css = `
    :root { color-scheme: light dark; }
    body { font: 14px/1.5 system-ui, sans-serif; margin: 2rem; max-width: 60rem; }
    h1 { margin-bottom: .25rem; }
    .summary span { display:inline-block; margin-right:1rem; font-weight:600; }
    .summary .passed { color:#1a7f37; } .summary .failed { color:#cf222e; } .summary .skipped { color:#9a6700; }
    table.matrix { border-collapse: collapse; margin:.5rem 0; }
    .matrix th, .matrix td { border:1px solid #8884; padding:.3rem .6rem; text-align:center; }
    .matrix .rowname, .matrix th { text-align:left; font-weight:600; }
    .cell.passed{color:#1a7f37} .cell.failed{color:#cf222e} .cell.skipped{color:#9a6700} .cell.partial{color:#9a6700} .cell.brittle{color:#bc4c00} .cell.none{opacity:.4}
    .legend { opacity:.7; font-size:.85em; }
    .card { border:1px solid #8884; border-left-width:4px; border-radius:6px; padding:.5rem 1rem; margin:.75rem 0; }
    .card.passed{border-left-color:#1a7f37} .card.failed{border-left-color:#cf222e} .card.skipped{border-left-color:#9a6700}
    .card header { display:flex; justify-content:space-between; align-items:baseline; gap:1rem; }
    .card h3 { margin:.3rem 0; font-size:1rem; }
    .meta { opacity:.7; font-size:.85em; white-space:nowrap; }
    .badge { font-size:.7em; text-transform:uppercase; padding:.1rem .4rem; border-radius:4px; color:#fff; }
    .badge.passed{background:#1a7f37} .badge.failed{background:#cf222e} .badge.skipped{background:#9a6700}
    .note { background:#8881; padding:.4rem .6rem; border-radius:4px; font-size:.9em; }
    ul.steps { list-style:none; padding-left:0; margin:.5rem 0; }
    .step { padding:.1rem 0; } .step .g { display:inline-block; width:1.2em; }
    .step.passed .g{color:#1a7f37} .step.failed .g{color:#cf222e} .step.skipped .g{color:#9a6700}
    .step .d { opacity:.8; }`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>mc-test report</title><style>${css}</style></head><body>
<h1>mc-test report</h1>
<p class="summary"><span>${total} tests</span><span class="passed">${passed} passed</span><span class="failed">${failed} failed</span><span class="skipped">${skipped} skipped</span></p>
${matrixTable(results)}
<h2>Tests</h2>
${results.map(testCard).join("\n")}
</body></html>
`;
}

/** Render and write the HTML report to disk. */
export function writeHtml(path: string, results: TestResult[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderHtml(results), "utf8");
}
