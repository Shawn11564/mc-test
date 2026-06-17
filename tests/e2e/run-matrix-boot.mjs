#!/usr/bin/env node
/**
 * Multi-loader fan-out E2E harness (F4 / ROADMAP §6.3). The orchestration sibling of
 * the F1 real-boot (run-real-boot.mjs) and F3 rendered-boot (run-rendered-boot.mjs)
 * harnesses — same check()/runCase() style + marker-based assertions. It proves the
 * F4 promise that the SAME unchanged test runs across the whole `(loader × version)`
 * matrix from one file, aggregates into ONE JUnit + a `(test × target)` skip matrix,
 * runs targets with per-target PARALLELISM, and honest-skips the cells it cannot run
 * (never a false green) — across paper (headless), fabric/forge/neoforge (inprocess).
 *
 *   node tests/e2e/run-matrix-boot.mjs
 *
 * The DETERMINISTIC core asserted here needs NO boot, no GL, no network, no Java: the
 * modular-loader (forge/neoforge) rows honest-skip at the preflight (UNSUPPORTED_TARGET,
 * CI-gated unless MC_TEST_RENDERED_LOADERS opts them in), and the client-GUI test on
 * the HEADLESS paper row honest-skips at driver selection (unmet:[clientScreens]) — both
 * short-circuit before provisioning. The rendered GREEN cells (fabric, and the opted-in
 * forge/neoforge boots) are GL-gated and proven by run-rendered-boot.mjs / the
 * `multi-loader-matrix` CI lane on a capable host. This harness is the permanent
 * guardrail for the fan-out wiring itself.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const CLI = "packages/runner/dist/cli.js";
const MATRIX = "tests/e2e/multi-loader.matrix.yml";
const OUT_DIR = "mc-test-report";
const JUNIT = join(OUT_DIR, "junit", "results.xml");
// The client-GUI regions test (clientScreens-gated): the case only a rendered client
// can run, so on headless paper it honest-skips and on forge/neoforge it honest-skips
// (CI-gated) — a perfect probe for the honest-skip half of the fan-out.
const CLIENTGUI = "examples/regions/regions.clientgui.mctest.yml";

// The rows that honest-skip WITHOUT a boot (deterministic everywhere): the headless
// paper row (clientScreens) + the two modular-loader rows (UNSUPPORTED_TARGET). Fabric
// is excluded from the deterministic run because it would attempt a real rendered boot
// (GL-gated) — that green is run-rendered-boot.mjs's job.
const DETERMINISTIC_TARGETS = "paper-1.20.4,forge-1.20.1-client,neoforge-1.21-client";

/** Run the CLI once; return { exit, out } with stdout+stderr combined. */
function runCase(stepFile, target, extra = []) {
  const r = spawnSync(
    process.execPath,
    [CLI, "run", stepFile, "--target", target, "--matrix", MATRIX, "--out", OUT_DIR, ...extra],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return { exit: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function readJUnit() {
  return existsSync(JUNIT) ? readFileSync(JUNIT, "utf8") : "";
}

/** Assert exit code + that every `includes` marker is present (and no `excludes`). */
function check(label, { exit, out }, expectExit, includes = [], excludes = []) {
  const problems = [];
  if (exit !== expectExit) problems.push(`exit ${exit} (expected ${expectExit})`);
  for (const m of includes) if (!out.includes(m)) problems.push(`missing marker: ${JSON.stringify(m)}`);
  for (const m of excludes) if (out.includes(m)) problems.push(`forbidden marker present: ${JSON.stringify(m)}`);
  const ok = problems.length === 0;
  console.log(`${ok ? "✓ PASS" : "✗ FAIL"}  ${label}`);
  if (!ok) {
    for (const p of problems) console.log(`        - ${p}`);
    console.log("        ---- output ----");
    console.log(
      out
        .split("\n")
        .filter((l) => /PASSED|FAILED|SKIPPED|skip|matrix|concurrency|UNSUPPORTED|COMPATIBLE|forge|neoforge|paper/i.test(l))
        .map((l) => `        ${l}`)
        .join("\n"),
    );
  }
  return ok;
}

if (!existsSync(CLI)) {
  console.error(`runner not built: ${CLI} — run: npm run build -w @mc-test/runner (and its deps)`);
  process.exit(2);
}

const results = [];

// 1) ORCHESTRATION + PARALLELISM — run three (target × test) jobs through the
//    bounded-concurrency pool. Asserts the concurrency banner, an aggregated JUnit,
//    the printed (test × target) skip matrix, and that NOTHING went green/red (the
//    three deterministic cells are honest skips). No boot happens.
{
  const run = runCase(CLIENTGUI, DETERMINISTIC_TARGETS, ["--concurrency", "3"]);
  results.push(
    check(
      "orchestration: 3 (target × test) jobs run with concurrency 3 → all honest-skip, exit 0",
      run,
      0,
      [
        "concurrency 3", // the bounded pool banner (F4 parallelism)
        "Skip matrix (test × target):", // the aggregated cross-target skip matrix
        "paper-1.20.4",
        "forge-1.20.1-client",
        "neoforge-1.21-client",
      ],
      ["— PASSED", "— FAILED"], // no cell should pass or fail in the deterministic run
    ),
  );
}

// 2) HONEST-SKIP DETAIL — the modular (forge/neoforge) rows cite the CI-gated reason
//    + the opt-in env var; the headless paper row cites the clientScreens capability
//    miss. Two different honest-skip mechanisms, both visible, never a false green.
{
  const run = runCase(CLIENTGUI, DETERMINISTIC_TARGETS, ["--concurrency", "3"]);
  results.push(
    check(
      "honest-skip detail: forge/neoforge CI-gated (UNSUPPORTED_TARGET) + paper clientScreens",
      run,
      0,
      [
        "CI-gated", // the forge/neoforge rendered-launch reason
        "MC_TEST_RENDERED_LOADERS=forge",
        "MC_TEST_RENDERED_LOADERS=neoforge",
        "UNSUPPORTED_TARGET", // forge/neoforge reason token (skip matrix reasons)
        "NO_COMPATIBLE_DRIVER", // paper headless reason token
        "unmet:[clientScreens]", // paper headless capability miss
      ],
      ["— PASSED"],
    ),
  );

  // The aggregated JUnit carries one <testsuite> per target with the machine-readable
  // skip reasons (the CI contract; the skip matrix is the human view).
  const xml = readJUnit();
  const xmlOk =
    xml.includes('name="forge-1.20.1-client"') &&
    xml.includes('name="neoforge-1.21-client"') &&
    xml.includes('name="paper-1.20.4"') &&
    xml.includes("UNSUPPORTED_TARGET") &&
    xml.includes("unmet:[clientScreens]");
  console.log(`${xmlOk ? "✓ PASS" : "✗ FAIL"}  JUnit aggregates 3 target suites with machine-readable skip reasons`);
  if (!xmlOk) console.log(`        - missing target suites / skip reasons in ${JUNIT}`);
  results.push(xmlOk);
}

// 3) DETERMINISTIC AGGREGATION — re-run and confirm the same cells skip with the same
//    reasons regardless of completion order (the pool preserves input order, so the
//    JUnit/skip-matrix are stable). Run sequentially this time to prove order-independence.
{
  const a = runCase(CLIENTGUI, DETERMINISTIC_TARGETS, ["--concurrency", "1"]);
  const b = runCase(CLIENTGUI, DETERMINISTIC_TARGETS, ["--concurrency", "3"]);
  const skips = (out) => (out.match(/— SKIPPED/g) ?? []).length;
  const ok = a.exit === 0 && b.exit === 0 && skips(a.out) === 3 && skips(b.out) === 3;
  console.log(`${ok ? "✓ PASS" : "✗ FAIL"}  deterministic: 3 honest skips at concurrency 1 AND 3 (order-independent)`);
  if (!ok) console.log(`        - exits ${a.exit}/${b.exit}, skips ${skips(a.out)}/${skips(b.out)} (expected 3/3)`);
  results.push(ok);
}

console.log(
  "\nnote: the rendered GREEN cells (fabric, and opted-in forge/neoforge via MC_TEST_RENDERED_LOADERS)" +
    "\n      need a GL-capable host — proven by tests/e2e/run-rendered-boot.mjs and the multi-loader-matrix CI lane.",
);

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} E2E checks passed.`);
process.exit(passed === results.length ? 0 : 1);
