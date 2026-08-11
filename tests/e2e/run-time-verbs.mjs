#!/usr/bin/env node
/**
 * Real-boot E2E harness for the phase-2 step-3 additions: the TIME verbs
 * (`waitForBlock` / `waitForPluginState`) and SIGN-EDITOR typing.
 *
 *   node tests/e2e/run-time-verbs.mjs
 *
 * Two groups:
 *
 *   Time verbs (headless Paper, always run given the agent jar): a genuinely deferred
 *   state — sand falling 20 blocks — that `waitForBlock` catches and an assert-once
 *   `getBlock` provably races. The negative control is the whole point: it is what
 *   distinguishes "the wait works" from "the state was already true".
 *
 *   Sign typing (RENDERED client, CI-gated): the server opens a real sign editor on a
 *   real client, `type` reaches it through the charTyped fallback, and `waitForBlock`
 *   confirms the text landed in the block entity — client action verified by server
 *   truth. Skipped (loudly) unless MC_TEST_RENDERED=1 and the Loom jars are built,
 *   because it needs a GL-capable host.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const CLI = "packages/runner/dist/cli.js";
const MATRIX = "tests/e2e/e2e.matrix.yml";
const AGENT_JAR = "agents/server-bukkit/build/libs/mc-test-agent-bukkit.jar";
const SUT_JAR = "examples/regions/plugin/target/regions-plugin.jar";
const CLIENT_AGENT_JAR = "agents/client-fabric/build/libs/agent-client-fabric.jar";

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
        .filter((l) => /PASSED|FAILED|SKIPPED|waitFor|getBlock|type:|fixture|error|Error/i.test(l))
        .map((l) => `        ${l}`)
        .join("\n"),
    );
  }
  return ok;
}

const missing = [
  [CLI, "runner not built — run: npm run build"],
  [AGENT_JAR, "truth agent missing — run: gradle -p agents :core:publishToMavenLocal :server-bukkit:jar"],
  [SUT_JAR, "SUT jar missing — run: mvn -f examples/regions/plugin/pom.xml package"],
].filter(([p]) => !existsSync(p));
if (missing.length) {
  console.error("Missing prerequisites:");
  for (const [p, hint] of missing) console.error(`  - ${p}: ${hint}`);
  process.exit(2);
}

const results = [];

// 1) POSITIVE — the deferred block state is caught by waitForBlock, and the plugin-state
//    wait resolves against real plugin state.
results.push(
  check(
    "positive: waitForBlock catches falling sand; waitForPluginState resolves real plugin state",
    runCase("tests/e2e/time-verbs.mctest.yml", "paper-time-verbs"),
    0,
    [
      "PASSED (",
      "waitForBlock: block 4,-60,0 = minecraft:sand",
      "waitForPluginState: pluginState regions.exists = true",
    ],
    ["SKIPPED", "FAILED ("],
  ),
);

// 2) NEGATIVE CONTROL — the same state read ONCE races and goes red. This is what makes
//    the positive run mean "the wait worked" rather than "it was already true".
results.push(
  check(
    "negative control: assert-once getBlock races the deferred state and fails",
    runCase("tests/e2e/time-verbs-negative.mctest.yml", "paper-time-verbs"),
    1,
    ["FAILED (", "expected minecraft:sand, got minecraft:air"],
    ["PASSED ("],
  ),
);

// 3) RENDERED CLIENT — sign typing through the charTyped fallback, confirmed by server truth.
const renderedOptIn = process.env["MC_TEST_RENDERED"] === "1";
if (renderedOptIn && existsSync(CLIENT_AGENT_JAR)) {
  results.push(
    check(
      "rendered: types onto a REAL sign editor via charTyped; server truth confirms the text",
      runCase("tests/e2e/client-sign-typing.mctest.yml", "fabric-client-signs"),
      0,
      ["PASSED (", "typed text (via screenCharTyped)", "nbt front_text ✓"],
      ["SKIPPED", "FAILED ("],
    ),
  );
  results.push(
    check(
      "rendered negative control: the wrong sign text fails, naming the offending line",
      runCase("tests/e2e/client-sign-typing-negative.mctest.yml", "fabric-client-signs"),
      1,
      ["FAILED (", "front_text.messages[0]", 'got "ChestShop"'],
      ["PASSED ("],
    ),
  );
} else {
  console.log(
    `⚠ SKIP  rendered sign-typing cases: ${
      renderedOptIn ? `${CLIENT_AGENT_JAR} not built` : "set MC_TEST_RENDERED=1 on a GL-capable host"
    }`,
  );
}

// 4) HONEST SKIP — the sign scenario on a headless target skips on clientScreens rather
//    than pretending a bot can see a client screen.
results.push(
  check(
    "honest skip: the sign scenario skips on a headless target (unmet clientScreens)",
    runCase("tests/e2e/client-sign-typing.mctest.yml", "paper-time-verbs"),
    0,
    ["SKIPPED", "no driver satisfies required capabilities {clientScreens}"],
    ["PASSED ("],
  ),
);

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} time-verb + sign-typing E2E checks passed.`);
process.exit(passed === results.length ? 0 : 1);
