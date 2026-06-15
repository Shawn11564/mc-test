/**
 * JUnit XML reporter. One `<testsuite>` per target, one `<testcase>` per test.
 * A test-level skip emits `<skipped>`; a failure emits `<failure>`; a passing
 * test with a honestly-skipped STEP (e.g. `assertPluginState` on the headless
 * driver) stays green AND emits a companion `<testcase>` with `<skipped>` so the
 * skip is first-class and visible in CI.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { TestResult } from "../model/result.js";

function escAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function cdata(s: string): string {
  return `<![CDATA[${s.replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;
}

const secs = (ms: number): string => (ms / 1000).toFixed(3);

/** Render the full JUnit document from a flat list of test results. */
export function renderJUnit(results: TestResult[]): string {
  const byTarget = new Map<string, TestResult[]>();
  for (const r of results) {
    const arr = byTarget.get(r.target) ?? [];
    arr.push(r);
    byTarget.set(r.target, arr);
  }

  let totalTests = 0;
  let totalFailures = 0;
  let totalSkipped = 0;
  let totalTime = 0;
  const suites: string[] = [];

  for (const [target, trs] of byTarget) {
    const cases: string[] = [];
    let sTests = 0;
    let sFail = 0;
    let sSkip = 0;
    let sTime = 0;

    for (const r of trs) {
      sTests++;
      totalTests++;
      sTime += r.durationMs / 1000;

      const props = (
        [
          ["loader", r.loader],
          ["mc", r.mc],
          ["driver", r.driver ?? "(none)"],
        ] as [string, string | undefined][]
      )
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `      <property name="${k}" value="${escAttr(String(v))}"/>`)
        .join("\n");

      const children: string[] = [];
      if (r.outcome === "skipped" && r.skip) {
        sSkip++;
        totalSkipped++;
        children.push(
          `    <skipped message="${escAttr(`${r.skip.reason} unmet:[${r.skip.unmet.join(",")}] — ${r.skip.message}`)}"/>`,
        );
      } else if (r.outcome === "failed" && r.failure) {
        sFail++;
        totalFailures++;
        children.push(
          `    <failure message="${escAttr(r.failure.message)}" type="${escAttr(r.failure.type)}">${cdata(r.systemOut ?? "")}</failure>`,
        );
      }
      if (r.systemOut) children.push(`    <system-out>${cdata(r.systemOut)}</system-out>`);

      cases.push(
        `  <testcase classname="${escAttr(target)}" name="${escAttr(r.name)}" time="${secs(r.durationMs)}">\n` +
          `    <properties>\n${props}\n    </properties>\n` +
          `${children.join("\n")}\n` +
          `  </testcase>`,
      );

      // Companion testcases for honestly-skipped steps (visible in CI dashboards).
      for (const st of r.steps) {
        if (st.outcome === "skipped" && st.skip) {
          sTests++;
          totalTests++;
          sSkip++;
          totalSkipped++;
          cases.push(
            `  <testcase classname="${escAttr(target)}" name="${escAttr(`${r.name} » ${st.verb}`)}" time="0.000">\n` +
              `    <skipped message="${escAttr(`${st.skip.reason} unmet:[${st.skip.unmet.join(",")}]`)}"/>\n` +
              `  </testcase>`,
          );
        }
      }
    }

    totalTime += sTime;
    suites.push(
      `<testsuite name="${escAttr(target)}" tests="${sTests}" failures="${sFail}" skipped="${sSkip}" errors="0" time="${sTime.toFixed(3)}">\n${cases.join("\n")}\n</testsuite>`,
    );
  }

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<testsuites name="mc-test" tests="${totalTests}" failures="${totalFailures}" skipped="${totalSkipped}" errors="0" time="${totalTime.toFixed(3)}">\n` +
    `${suites.join("\n")}\n` +
    `</testsuites>\n`
  );
}

/** Render and write the JUnit XML to disk. */
export function writeJUnit(path: string, results: TestResult[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderJUnit(results), "utf8");
}
