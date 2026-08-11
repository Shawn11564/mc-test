#!/usr/bin/env node
/**
 * Real-boot E2E harness for the phase-2 TRUTH VOCABULARY: `expectProperties` on
 * blockstates, block-entity NBT, and `getContainer`/`getItem` with component-exact
 * item identity.
 *
 *   node tests/e2e/run-truth-vocabulary.mjs
 *
 * Prereqs: the built runner (`npm run build`) AND the Bukkit truth agent
 * (`gradle -p agents :core:publishToMavenLocal :server-bukkit:jar`) — these are
 * server-truth assertions, so without the agent there is nothing to assert against
 * and the harness exits 2 rather than reporting a hollow green.
 *
 * Three checks: the positive run, and one negative control per assertion class.
 * The negatives are the point — a property matcher that ignored `facing`, or an
 * identity that was just `type` + `count`, would pass the positive run too.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const CLI = "packages/runner/dist/cli.js";
const MATRIX = "tests/e2e/e2e.matrix.yml";
const TARGET = "paper-interaction-agent";
const AGENT_JAR = "agents/server-bukkit/build/libs/mc-test-agent-bukkit.jar";

function runCase(stepFile) {
  const r = spawnSync(process.execPath, [CLI, "run", stepFile, "--target", TARGET, "--matrix", MATRIX], {
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
        .filter((l) => /PASSED|FAILED|SKIPPED|getBlock|getItem|getContainer|useBlock|error|Error/i.test(l))
        .map((l) => `        ${l}`)
        .join("\n"),
    );
  }
  return ok;
}

const missing = [
  [CLI, "runner not built — run: npm run build"],
  [AGENT_JAR, "truth agent missing — run: gradle -p agents :core:publishToMavenLocal :server-bukkit:jar"],
].filter(([p]) => !existsSync(p));
if (missing.length) {
  console.error("Missing prerequisites:");
  for (const [p, hint] of missing) console.error(`  - ${p}: ${hint}`);
  process.exit(2);
}

const results = [];

// 1) POSITIVE — facing on a placed wall sign, sign-text NBT, container contents, and
//    two same-material swords distinguished by their components.
results.push(
  check(
    "positive: facing=east on the placed sign, sign NBT, and component-exact chest slots",
    runCase("tests/e2e/truth-vocabulary.mctest.yml"),
    0,
    [
      "PASSED (",
      "properties facing=east ✓",
      "nbt front_text ✓",
      "container minecraft:chest at 2,-60,0: 2/27 occupied",
      'getItem: item 2,-60,0[0] = 1× minecraft:diamond_sword "Excalibur"',
      "getItem: item 2,-60,0[5] = <empty> ✓",
    ],
    ["SKIPPED", "FAILED ("],
  ),
);

// 2) NEGATIVE — the sign goes on the NORTH face while the test still asserts east.
//    The block TYPE matches either way, so only expectProperties can catch this.
results.push(
  check(
    "negative control: a sign on the wrong face fails the facing assertion",
    runCase("tests/e2e/truth-vocabulary-negative.mctest.yml"),
    1,
    ["FAILED (", 'facing: expected "east", got "north"'],
    ["PASSED ("],
  ),
);

// 3) NEGATIVE — a plain diamond sword satisfies type+count but must NOT satisfy the
//    named/enchanted sword's components. This is the "only equals itself" property.
results.push(
  check(
    "negative control: a plain sword is not the enchanted one (type+count is not identity)",
    runCase("tests/e2e/truth-item-identity-negative.mctest.yml"),
    1,
    ["FAILED (", "components.enchants", "getItem: item 2,-60,0[1]"],
    ["PASSED ("],
  ),
);

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} truth-vocabulary E2E checks passed.`);
process.exit(passed === results.length ? 0 : 1);
