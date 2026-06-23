#!/usr/bin/env node
/**
 * Rendered-client E2E harness — ALL THREE LOADERS (F3 + F4/M5). The multi-loader sibling of
 * tests/e2e/run-rendered-boot.mjs (which proves the Fabric rendered client only): it boots a REAL
 * rendered Minecraft CLIENT for Fabric, Forge AND NeoForge, drives each SUT mod's client Screen over
 * MCTP (the canonical, loader-agnostic examples/regions/regions.clientgui.mctest.yml — selects by visible
 * label + input role, no testId, so the SAME file runs unchanged on all three), and asserts the GUI flow
 * + the server-side pluginState GREEN via the co-selected Paper/Bukkit agent.
 *
 *   bash scripts/run-rendered-docker.sh --harness tests/e2e/run-rendered-loaders.mjs   # off-screen (Xvfb+Mesa)
 *   MC_TEST_RENDERED_LOADERS=forge,neoforge xvfb-run -a node tests/e2e/run-rendered-loaders.mjs   # Linux/CI
 *
 * REQUIRES A GL-CAPABLE DISPLAY (a rendered client renders frames): run it under Xvfb+Mesa in the
 * Dockerfile.rendered image (no window touches your desktop) or a desktop runner — NOT plain offline CI.
 * Forge/NeoForge rendered launches are opt-in via MC_TEST_RENDERED_LOADERS (this harness sets it); without
 * it those rows honest-skip UNSUPPORTED_TARGET (never a false green). Each loader is also gated on its built
 * client-agent + SUT-mod jars: a loader whose jars aren't built is an HONEST SKIP (printed, not a failure).
 *
 * Marker-based assertions (a false green at exit 0 is caught by also requiring the per-loader GUI markers).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

// Forge/NeoForge rendered launches are CI-gated behind this opt-in; the child CLI inherits it. (Set it
// BEFORE spawning. Fabric is not gated and runs regardless.) Respect a caller-provided value if present.
process.env["MC_TEST_RENDERED_LOADERS"] = process.env["MC_TEST_RENDERED_LOADERS"] || "fabric,forge,neoforge";

const CLI = "packages/runner/dist/cli.js";
const MATRIX = "mc-test.yml"; // the canonical matrix carries the three -client rows (server-side plugin + SUT mod + display:xvfb)
const CLIENTGUI = "examples/regions/regions.clientgui.mctest.yml";

// Server-side truth half is the Paper/Bukkit agent + the regions PLUGIN (the SUT mod is client-side);
// shared by every -client row, so gate on them once.
const SERVER_PREREQS = [
  ["agents/server-bukkit/build/libs/mc-test-agent-bukkit.jar", "gradle -p agents :server-bukkit:jar"],
  ["examples/regions/plugin/target/regions-plugin.jar", "mvn -f examples/regions/plugin/pom.xml package"],
];

const LOADERS = [
  {
    id: "fabric",
    target: "fabric-1.21-client",
    agent: "agents/client-fabric/build/libs/agent-client-fabric.jar",
    mod: "examples/regions/mod-fabric/build/libs/openregions-fabric.jar",
  },
  {
    id: "forge",
    target: "forge-1.20.1-client",
    agent: "agents/client-forge/build/libs/agent-client-forge.jar",
    mod: "examples/regions/mod-forge/build/libs/openregions-forge.jar",
  },
  {
    id: "neoforge",
    target: "neoforge-1.21-client",
    agent: "agents/client-neoforge/build/libs/agent-client-neoforge.jar",
    mod: "examples/regions/mod-neoforge/build/libs/openregions-neoforge.jar",
  },
];

/** Run the CLI once across `target` (may be comma-joined); return { exit, out }. */
function runCase(target, out = "mc-test-report") {
  const r = spawnSync(
    process.execPath,
    [CLI, "run", CLIENTGUI, "--target", target, "--matrix", MATRIX, "--out", out],
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
        .filter((l) => /PASSED|FAILED|SKIPPED|join|command|click|waitForScreen|assert|screenshot|UNSUPPORTED|error|Error/i.test(l))
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
const missingServer = SERVER_PREREQS.filter(([p]) => !existsSync(p));
if (missingServer.length) {
  console.error("Missing server-side prerequisites (the Paper/Bukkit truth half every -client row shares):");
  for (const [p, hint] of missingServer) console.error(`  - ${p}: ${hint}`);
  process.exit(2);
}

const built = LOADERS.filter((l) => existsSync(l.agent) && existsSync(l.mod));
for (const l of LOADERS.filter((l) => !(existsSync(l.agent) && existsSync(l.mod)))) {
  console.log(`○ SKIP  ${l.id} rendered client — client agent and/or SUT mod jar not built (build the ${l.id} toolchain)`);
}

if (built.length === 0) {
  console.log("\nNo rendered-client loaders are built — every rendered boot was honestly skipped.");
  console.log("Build e.g. the client-fabric agent + mod-fabric (Loom) to run a real rendered boot.");
  process.exit(0);
}

// ONE aggregated run across every built loader → a single mc-test-report/report.html with one card per
// loader (each: rendered client boots + opens the SUT's OpenRegions Screen + create/load region over MCTP +
// assertPluginState GREEN via the Bukkit agent). The per-loader GUI markers catch a false exit-0 green.
const result = check(
  `rendered clients GREEN — GUI flow + pluginState over MCTP (${built.map((l) => l.id).join(", ")})`,
  runCase(built.map((l) => l.target).join(",")),
  0,
  [
    "— PASSED",
    "OpenRegions", // waitForScreen matched the SUT mod's client Screen title
    "clicked label=", // click-by-label drove the real client widgets
    "Region created: Sanctuary", // typeText + Create round-tripped through the client GUI
    "Region loaded: TestRegion",
    "assertPluginState: pluginState regions.exists = true", // server-side truth via the Bukkit agent
  ],
  ["— FAILED"],
);

// Each BUILT loader must show its own PASSED card (so a green isn't one loader carrying a skipped sibling).
const perLoader = built.map((l) => {
  const ok = runCase(l.target).out.includes("— PASSED");
  console.log(`${ok ? "✓" : "✗"}  ${l.id} (${l.target}): ${ok ? "rendered green" : "NOT green"}`);
  return ok;
});

const checks = [result, ...perLoader];
const passed = checks.filter(Boolean).length;
console.log(`\n${passed}/${checks.length} rendered-loader checks passed (${built.length} loader(s) with built jars).`);
process.exit(passed === checks.length ? 0 : 1);
