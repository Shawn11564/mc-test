#!/usr/bin/env node
/**
 * F5 real-boot E2E harness — MODDED SERVERS. Boots a real Fabric/Forge/NeoForge dedicated
 * server per loader (no display needed), downloads a real third-party mod from Modrinth
 * (FerriteCore), and asserts over MCTP that the loader actually loaded it — the
 * `truth.assertPluginState { mod.loaded }` query against the co-selected server-* truth agent,
 * driven by the cost-1 `server` driver (a server-truth-only session, NO player join).
 *
 *   node tests/e2e/run-modded-server-boot.mjs
 *
 * Prereqs: the runner built (`npm run build`). The server-* truth agents are ACCEPTANCE-ONLY
 * (ForgeGradle/NeoGradle/Loom + network + mappings), so this harness GATES each loader on its
 * built agent jar: a loader whose agent is not built is an HONEST SKIP (printed, not a failure) —
 * never a false green. Fabric (Loom) is the showcase most likely to build in the e2e lane.
 *
 * It asserts step markers, not just exit codes, so a false green (exit 0 without the real
 * mod.loaded assertion) is caught.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const CLI = "packages/runner/dist/cli.js";
const MATRIX = "tests/e2e/modded-server.matrix.yml";
const POSITIVE = "examples/regions/regions.modloaded.mctest.yml";
const NEGATIVE = "tests/e2e/modloaded-negative.mctest.yml";

const LOADERS = [
  { id: "fabric", target: "fabric-server-1.21", jar: "agents/server-fabric/build/libs/agent-server-fabric.jar" },
  { id: "neoforge", target: "neoforge-server-1.21", jar: "agents/server-neoforge/build/libs/agent-server-neoforge.jar" },
  { id: "forge", target: "forge-server-1.20.1", jar: "agents/server-forge/build/libs/agent-server-forge.jar" },
];

/** Run the CLI once; return { exit, out } with stdout+stderr combined. */
function runCase(stepFile, target, out = "mc-test-report") {
  const r = spawnSync(
    process.execPath,
    [CLI, "run", stepFile, "--target", target, "--matrix", MATRIX, "--out", out],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
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
    console.log(
      out
        .split("\n")
        .filter((l) => /PASSED|FAILED|SKIPPED|mod\.loaded|boot-log|ferritecore|error|Error/i.test(l))
        .map((l) => `        ${l}`)
        .join("\n"),
    );
  }
  return ok;
}

if (!existsSync(CLI)) {
  console.error("runner not built — run: npm run build");
  process.exit(2);
}

const results = [];
const built = LOADERS.filter((l) => existsSync(l.jar));
for (const { id, jar } of LOADERS.filter((l) => !existsSync(l.jar))) {
  console.log(`○ SKIP  ${id} modded server — ${jar} not built (acceptance-only; build with the ${id} toolchain)`);
}

if (built.length) {
  // ONE aggregated positive run across every built loader → a single mc-test-report/report.html
  // with one green card per loader (each: modded server boots + FerriteCore downloaded from
  // Modrinth + mod.loaded = true over MCTP; no player joined — driver: server).
  results.push(
    check(
      `modded servers boot + download FerriteCore + mod.loaded GREEN over MCTP (${built.map((l) => l.id).join(", ")})`,
      runCase(POSITIVE, built.map((l) => l.target).join(",")),
      0,
      ["PASSED (", "mod.loaded = true", "ferritecore"],
    ),
  );
  // NEGATIVE control — only meaningful with a real agent: a mod that ISN'T installed → RED. Written
  // to a separate out dir so the main report.html keeps showing the green positive run.
  const fabric = built.find((l) => l.id === "fabric") ?? built[0];
  results.push(
    check(
      "negative: asserting an absent mod is loaded → RED (not a rubber stamp)",
      runCase(NEGATIVE, fabric.target, "mc-test-report/_negative"),
      1,
      ["FAILED (", "assertPluginState: FAILED"],
    ),
  );
}

if (built.length === 0) {
  console.log("\nNo server-* agent jars are built — every modded-server boot was honestly skipped");
  console.log("(the agents are acceptance-only). Build e.g. agents/server-fabric (Loom) to run the real boots.");
  console.log("The cost-1 `server` driver, mod.loaded probe, and modrinth resolver are covered offline by the unit suites.");
  process.exit(0);
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} modded-server E2E checks passed (${built.length} loader(s) with a built agent).`);
process.exit(passed === results.length ? 0 : 1);
