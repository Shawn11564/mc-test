#!/usr/bin/env node
/**
 * Real-boot E2E harness for the phase-2 WORLD-INTERACTION verbs
 * (`useBlock`/`attackBlock`/`setHeldItem`/`look`/`move`, cap `worldInteraction`).
 *
 *   node tests/e2e/run-world-interaction.mjs
 *
 * Prereqs: the built runner (`npm run build`). The agent-backed case additionally
 * needs `gradle -p agents :core:publishToMavenLocal :server-bukkit:jar`; it is
 * SKIPPED (loudly, never silently green) when that jar is absent. No SUT jar is
 * needed at all — the scenario arranges its own world with vanilla commands.
 *
 * The four checks are a positive run, its negative control, a truth-confirmed
 * run, and a capability skip — i.e. it proves the verbs work, that they are not
 * no-ops, that the world really changed, and that a driver without the capability
 * says so instead of pretending.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const CLI = "packages/runner/dist/cli.js";
const MATRIX = "tests/e2e/e2e.matrix.yml";
const POSITIVE = "tests/e2e/world-interaction.mctest.yml";
const NEGATIVE = "tests/e2e/world-interaction-negative.mctest.yml";
const AGENT_JAR = "agents/server-bukkit/build/libs/mc-test-agent-bukkit.jar";

function runCase(stepFile, target) {
  const r = spawnSync(process.execPath, [CLI, "run", stepFile, "--target", target, "--matrix", MATRIX], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return { exit: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

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
        .filter((l) => /PASSED|FAILED|SKIPPED|useBlock|attackBlock|setHeldItem|look|move|MCTEST_|error|Error/i.test(l))
        .map((l) => `        ${l}`)
        .join("\n"),
    );
  }
  return ok;
}

if (!existsSync(CLI)) {
  console.error(`Missing prerequisite: ${CLI} — run: npm run build`);
  process.exit(2);
}

const results = [];

// 1) POSITIVE — sneak-clicking a chest face places the held sign on THAT face,
//    confirmed by the server itself (`/execute if block` → chat marker).
results.push(
  check(
    "positive: sneak-click chest face places the sign on that face (server-confirmed)",
    runCase(POSITIVE, "paper-interaction"),
    0,
    [
      "PASSED (",
      "setHeldItem: holding minecraft:oak_sign",
      "useBlock: sneak-used minecraft:chest at 2,-60,0 face north",
      "MCTEST_SIGN_ON_FACE",
      "MCTEST_CHEST_INTACT",
      "attackBlock: attacked minecraft:oak_wall_sign",
      "MCTEST_SIGN_REMOVED",
      // No agent on this target → the authoritative reads must SKIP, not pass.
      "getBlock: SKIPPED",
      "unmet=[worldTruth]",
    ],
    ["FAILED ("],
  ),
);

// 2) NEGATIVE CONTROL — the SAME click without sneak places nothing. Without this,
//    the positive run would still be green if `sneak` never reached the server.
results.push(
  check(
    "negative control: the same click WITHOUT sneak places nothing",
    runCase(NEGATIVE, "paper-interaction"),
    0,
    ["PASSED (", "useBlock: used minecraft:chest", "MCTEST_FACE_STILL_AIR"],
    ["sneak-used", "FAILED ("],
  ),
);

// 3) TRUTH-CONFIRMED — with the Bukkit agent co-selected the getBlock steps RUN,
//    so the placement is asserted against authoritative server state over MCTP.
if (existsSync(AGENT_JAR)) {
  results.push(
    check(
      "truth: with server-bukkit co-selected, getBlock confirms the wall sign over MCTP",
      runCase(POSITIVE, "paper-interaction-agent"),
      0,
      [
        "PASSED (",
        "getBlock: block 2,-60,-1 = minecraft:oak_wall_sign",
        "getBlock: block 2,-60,-1 = minecraft:air",
      ],
      ["getBlock: SKIPPED"],
    ),
  );
} else {
  console.log(`⚠ SKIP  truth-confirmed case: ${AGENT_JAR} not built (gradle -p agents :server-bukkit:jar)`);
}

// 4) CAPABILITY SKIP — the pixel/OCR stub advertises no worldInteraction, so the
//    scenario is skipped with a machine-readable reason and nothing is booted.
results.push(
  check(
    "honest skip: pixel driver has no worldInteraction → NO_COMPATIBLE_DRIVER",
    runCase(POSITIVE, "pixel-interaction"),
    0,
    ["SKIPPED", "no driver satisfies required capabilities {worldInteraction}"],
    ["PASSED ("],
  ),
);

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} world-interaction E2E checks passed.`);
process.exit(passed === results.length ? 0 : 1);
