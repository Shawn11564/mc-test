#!/usr/bin/env node
/**
 * Rendered-client E2E harness (F3). The in-process (`inprocess`) sibling of the F1
 * real-boot harness (tests/e2e/run-real-boot.mjs) — same check()/runCase() style,
 * marker-based assertions, prereq gate, --flake budget. It turns the F3 "rendered
 * client" proof into a permanent guardrail: a REAL Fabric Minecraft client renders
 * the SUT mod's client Screen, driven over MCTP, while a Paper server + the Bukkit
 * agent (server-bukkit) supply server-side truth. This is the payload of the
 * `fabric-rendered-client` job in e2e.yml and is runnable locally:
 *
 *   node tests/e2e/run-rendered-boot.mjs            # full run (flake budget N=3)
 *   node tests/e2e/run-rendered-boot.mjs --flake=1  # quick (single positive run)
 *
 * It asserts the OUTCOME of each scenario (the right step markers), not just exit
 * codes — a false green (exit 0) is caught by also requiring the GUI-flow markers.
 *
 * Prereqs (built by e2e.yml / docs/V1_PLAN.md F3):
 *   npm run build -w @mc-test/runner                 (and its deps)
 *   gradle -p agents :core:publishToMavenLocal :server-bukkit:jar
 *   mvn -f examples/regions/plugin/pom.xml package    # server-side regions plugin
 *   (cd agents/client-fabric && ./gradlew build)         # Loom: agent-client-fabric.jar
 *   (cd examples/regions/mod-fabric && ./gradlew build)  # Loom: openregions-fabric.jar (client SUT mod)
 *
 * Two of the three checks below need a GL-capable environment (a rendered client
 * under Xvfb/Mesa or a desktop runner); the honest-skip check does NOT. That is
 * expected — the harness is the permanent guardrail CI runs under a virtual display.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const CLI = "packages/runner/dist/cli.js";
const MATRIX = "tests/e2e/e2e.matrix.yml";
const OUT_DIR = "mc-test-report";
const JUNIT = join(OUT_DIR, "junit", "results.xml");
// The CLIENT-GUI variant of the canonical regions test (clientScreens-gated): the
// case the headless bot provably cannot see, only the in-process rendered client.
const CLIENTGUI = "examples/regions/regions.clientgui.mctest.yml";
// Targets in e2e.matrix.yml: a plain HEADLESS paper row (clientgui honest-skips on it)
// and the F3 RENDERED-CLIENT row (clientgui runs on it).
const HEADLESS_TARGET = "paper-agent";
const CLIENT_TARGET = "fabric-client";

const flakeArg = process.argv.find((a) => a.startsWith("--flake="));
const FLAKE_RUNS = flakeArg ? Math.max(1, Number(flakeArg.split("=")[1]) || 1) : 3;

/** Run the CLI once; return { exit, out } with stdout+stderr combined. */
function runCase(stepFile, target) {
  const r = spawnSync(
    process.execPath,
    [CLI, "run", stepFile, "--target", target, "--matrix", MATRIX, "--out", OUT_DIR],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return { exit: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** Read the aggregated JUnit XML the last runCase wrote (for structured skip tokens). */
function readJUnit() {
  return existsSync(JUNIT) ? readFileSync(JUNIT, "utf8") : "";
}

/** Recursively collect file paths under a dir (best-effort; [] if absent). */
function walk(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
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
        .filter((l) => /PASSED|FAILED|SKIPPED|join|command|click|waitForScreen|assert|screenshot|fixture|error|Error/i.test(l))
        .map((l) => `        ${l}`)
        .join("\n"),
    );
  }
  return ok;
}

// Fail fast with a clear message if the artifacts the rendered boot needs aren't built.
// The two Loom jars are acceptance-only (Fabric Loom needs network + a Minecraft/Yarn
// download), so they are gated here rather than assumed.
const prereqs = [
  [CLI, "runner not built — run: npm run build -w @mc-test/runner (and its deps)"],
  [
    "agents/server-bukkit/build/libs/mc-test-agent-bukkit.jar",
    "server agent jar missing — run: gradle -p agents :server-bukkit:jar",
  ],
  [
    "examples/regions/plugin/target/regions-plugin.jar",
    "server-side regions plugin missing — run: mvn -f examples/regions/plugin/pom.xml package",
  ],
  [
    "agents/client-fabric/build/libs/agent-client-fabric.jar",
    "client-fabric agent jar missing (Loom) — run: (cd agents/client-fabric && ./gradlew build)",
  ],
  [
    "examples/regions/mod-fabric/build/libs/openregions-fabric.jar",
    "client SUT mod jar missing (Loom) — run: (cd examples/regions/mod-fabric && ./gradlew build)",
  ],
];
const missing = prereqs.filter(([p]) => !existsSync(p));
if (missing.length) {
  console.error("Missing prerequisites:");
  for (const [p, hint] of missing) console.error(`  - ${p}: ${hint}`);
  process.exit(2);
}

const results = [];

// 1) HONEST-SKIP — the clientgui test on the HEADLESS paper target. The headless bot
//    advertises containerGui but NOT clientScreens, so the WHOLE test is skipped at
//    driver selection: runTarget early-returns skip {reason: NO_COMPATIBLE_DRIVER,
//    unmet:["clientScreens"]}. printResult prints "— SKIPPED" + "→ skipped: no driver
//    satisfies required capabilities {clientScreens}". This check needs NO rendered
//    client, so it is the one that always runs — keep it robust.
{
  const run = runCase(CLIENTGUI, HEADLESS_TARGET);
  // Console markers: the whole test is SKIPPED and the unmet cap is clientScreens.
  let ok = check(
    "honest-skip: clientgui on headless paper → WHOLE TEST SKIPPED unmet=[clientScreens]",
    run,
    0,
    ["— SKIPPED", "clientScreens", "no driver satisfies required capabilities"],
    ["— PASSED"],
  );
  // Structured tokens (NO_COMPATIBLE_DRIVER + unmet:[clientScreens]) live in the JUnit XML
  // (`<skipped message="NO_COMPATIBLE_DRIVER unmet:[clientScreens] — …"/>`), not the console
  // for a single-target run (the cross-target skip matrix only prints with >1 result).
  const xml = readJUnit();
  const xmlOk =
    xml.includes("NO_COMPATIBLE_DRIVER") && xml.includes("unmet:[clientScreens]");
  console.log(`${xmlOk ? "✓ PASS" : "✗ FAIL"}  honest-skip: JUnit carries NO_COMPATIBLE_DRIVER unmet:[clientScreens]`);
  if (!xmlOk) console.log(`        - missing NO_COMPATIBLE_DRIVER / unmet:[clientScreens] in ${JUNIT}`);
  results.push(ok && xmlOk);
}

// 2) POSITIVE (rendered) — the clientgui test on the in-process fabric-client target.
//    A REAL rendered client drives the SUT mod's client Screen; the co-selected Bukkit
//    agent answers assertPluginState. Asserts the full GUI flow + the pluginState GREEN
//    verdict, not just exit 0. (Only passes in a GL-capable environment — expected.)
const positiveRun = runCase(CLIENTGUI, CLIENT_TARGET);
results.push(
  check(
    "positive (rendered): clientgui green on fabric-client INCLUDING assertPluginState",
    positiveRun,
    0,
    [
      "— PASSED",
      // GUI flow over clientScreens (executeStep step-detail strings). The cross-loader test selects
      // by visible LABEL + the input's ROLE (not testId), so the SUT mods stay loader-agnostic.
      "screen opened:", // waitForScreen detail
      "typed text", // the `type` step typed a region name into the text field (role:input)
      "clicked label=", // click-by-label detail (Regions / Create / TestRegion)
      "Region loaded", // assertChat matched the SUT's chat line
      // assertPluginState GREEN against real plugin state (same marker as F1's positive run).
      "assertPluginState: pluginState regions.exists = true",
    ],
    ["— SKIPPED", "— FAILED"],
  ),
);

// 3) SCREENSHOT — after the positive run, the screenshot step either captured a frame OR honestly
//    SKIPPED. The runner's per-step union now reflects the agent's LIVE granted caps, and the client
//    agent computes caps at startup (before the framebuffer exists), so it typically does NOT grant
//    `screenshot` and the step skips `unmet:[screenshot]` (never a false green). A capture marker
//    ("screenshot → <path>" / "captured screenshot"), a .png artifact, OR an honest skip all count.
{
  const pngs = walk(OUT_DIR).filter((f) => f.toLowerCase().endsWith(".png"));
  const captured =
    positiveRun.out.includes("captured screenshot") || positiveRun.out.includes("screenshot →");
  const skipped =
    positiveRun.out.includes("unmet=[screenshot]") || positiveRun.out.includes("unmet:[screenshot]");
  const ok = captured || pngs.length > 0 || skipped;
  console.log(
    `${ok ? "✓ PASS" : "✗ FAIL"}  screenshot: captured a frame, dropped a .png, or honestly skipped (unmet:[screenshot])`,
  );
  if (!ok) {
    console.log(`        - no capture marker, no .png under ${OUT_DIR}, and no honest skip`);
  } else if (pngs.length) {
    console.log(`        screenshot file(s): ${pngs.join(", ")}`);
  }
  results.push(ok);
}

// 4) FLAKE BUDGET — the positive rendered run must be deterministic across N repeats.
let flakeOk = true;
for (let i = 1; i <= FLAKE_RUNS; i++) {
  const { exit, out } = runCase(CLIENTGUI, CLIENT_TARGET);
  const pass = exit === 0 && out.includes("assertPluginState: pluginState regions.exists = true");
  console.log(`${pass ? "✓" : "✗"}  flake budget run ${i}/${FLAKE_RUNS}: ${pass ? "green" : "NONDETERMINISTIC"}`);
  if (!pass) flakeOk = false;
}
results.push(check(`flake budget: ${FLAKE_RUNS} positive rendered runs all green`, { exit: flakeOk ? 0 : 1, out: "" }, 0));

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} E2E checks passed.`);
process.exit(passed === results.length ? 0 : 1);
