#!/usr/bin/env node
/**
 * Real-boot E2E harness (F1). Boots a real Paper server per scenario via the
 * mc-test CLI and asserts the OUTCOME of each — turning the one-off F1 proofs into
 * permanent guardrails. This is the payload of the e2e.yml workflow and is runnable
 * locally:
 *
 *   node tests/e2e/run-real-boot.mjs            # full run (flake budget N=3)
 *   node tests/e2e/run-real-boot.mjs --flake=1  # quick (single positive run)
 *
 * Prereqs (built by e2e.yml / docs/V1_PLAN.md F1):
 *   gradle -p agents :core:publishToMavenLocal :server-bukkit:jar
 *   mvn -f examples/regions/plugin/pom.xml package
 *   npm run build -w @mc-test/runner   (and its deps)
 *
 * It asserts the "tester doesn't lie" triad + fixtures, NOT just exit codes — a
 * false green (exit 0) is caught by also requiring the right step markers.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const CLI = "packages/runner/dist/cli.js";
const MATRIX = "tests/e2e/e2e.matrix.yml";

const flakeArg = process.argv.find((a) => a.startsWith("--flake="));
const FLAKE_RUNS = flakeArg ? Math.max(1, Number(flakeArg.split("=")[1]) || 1) : 3;

/** Run the CLI once; return { exit, out } with stdout+stderr combined. */
function runCase(stepFile, target) {
  const r = spawnSync(process.execPath, [CLI, "run", stepFile, "--target", target, "--matrix", MATRIX], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return { exit: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
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
        .filter((l) => /PASSED|FAILED|SKIPPED|join|command|click|assert|fixture|spawn|error|Error/i.test(l))
        .map((l) => `        ${l}`)
        .join("\n"),
    );
  }
  return ok;
}

// Fail fast with a clear message if the artifacts the boots need aren't built.
const prereqs = [
  [CLI, "runner not built — run: npm run build -w @mc-test/runner (and its deps)"],
  ["agents/server-bukkit/build/libs/mc-test-agent-bukkit.jar", "agent jar missing — run: gradle -p agents :server-bukkit:jar"],
  ["examples/regions/plugin/target/regions-plugin.jar", "SUT jar missing — run: mvn -f examples/regions/plugin/pom.xml package"],
];
const missing = prereqs.filter(([p]) => !existsSync(p));
if (missing.length) {
  console.error("Missing prerequisites:");
  for (const [p, hint] of missing) console.error(`  - ${p}: ${hint}`);
  process.exit(2);
}

const results = [];

// 1) POSITIVE — region created → assertPluginState GREEN against real state.
results.push(
  check(
    "positive: regions test green INCLUDING assertPluginState (agent co-selected)",
    runCase("examples/regions/regions.mctest.yml", "paper-agent"),
    0,
    ["PASSED (", "assertPluginState: pluginState regions.exists = true"],
  ),
);

// 2) HONEST-SKIP — no agent → assertPluginState SKIPPED, never a false pass.
results.push(
  check(
    "honest-skip: no agent → assertPluginState SKIPPED unmet=[pluginState]",
    runCase("examples/regions/regions.mctest.yml", "paper-noagent"),
    0,
    ["PASSED (", "assertPluginState: SKIPPED", "unmet=[pluginState]"],
  ),
);

// 3) TRUTH/UI-DIVERGENCE — UI "lies" (ghost region) → assertPluginState RED.
results.push(
  check(
    "divergence: ghost region → assertPluginState RED while chat is green",
    runCase("tests/e2e/truth-divergence.mctest.yml", "paper-agent"),
    1,
    ["FAILED (", "assertPluginState: FAILED", "regions.exists = false"],
  ),
);

// 4) FIXTURES — deterministic create/reset against real state + honest fake-player skip.
results.push(
  check(
    "fixtures: createRegion→true, reset→false; spawnFakePlayer honestly skips",
    runCase("tests/e2e/fixtures.mctest.yml", "paper-agent"),
    0,
    [
      "PASSED (",
      "fixture regions.createRegion",
      "regions.exists = true",
      "spawnFakePlayer: SKIPPED",
      "unmet=[fakePlayers]",
      "regions.exists = false",
    ],
  ),
);

// 5) FLAKE BUDGET — the positive run must be deterministic across N repeats.
let flakeOk = true;
for (let i = 1; i <= FLAKE_RUNS; i++) {
  const { exit, out } = runCase("examples/regions/regions.mctest.yml", "paper-agent");
  const pass = exit === 0 && out.includes("assertPluginState: pluginState regions.exists = true");
  console.log(`${pass ? "✓" : "✗"}  flake budget run ${i}/${FLAKE_RUNS}: ${pass ? "green" : "NONDETERMINISTIC"}`);
  if (!pass) flakeOk = false;
}
results.push(check(`flake budget: ${FLAKE_RUNS} positive runs all green`, { exit: flakeOk ? 0 : 1, out: "" }, 0));

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} E2E checks passed.`);
process.exit(passed === results.length ? 0 : 1);
