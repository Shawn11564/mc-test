#!/usr/bin/env node
/**
 * Runner-judged macros over MCTP (spike for the feature-map plan, CC spec/40): boots a real NeoForge and Fabric 1.21.1 server
 * (each with its server agent) and MCTEST_MACROS pointing at a scratch folder, starts macros with
 * `bench.runMacro`, and follows each one through `event.macroStep` / `event.macroEnd`, printing the steps as one
 * linear list the way a live view would. Every `expect` is judged HERE, from the evidence window the step reports
 * (what its player was told inside the window); the agent's own reading arrives as `hint` and is only compared.
 *
 *   1. a passing macro: every step starts and ends once, in order, nested `run` steps one level deeper, and every
 *      check the runner judges passes (positive control);
 *   2. a macro whose expect must fail: the runner says fail and shows what the player was told instead, the run
 *      carries on past it, and a `-/` failure is "carriedOn" (negative control);
 *   3. a macro whose command is refused: that step fails, the run ends "stopped", the next step never starts;
 *   4. the runner's verdict never comes from `hint`: the same judge, given a window with the matching message taken
 *      out, says fail although hint says pass (tamper control, no server needed);
 *   5. bad requests are refused: an unknown macro, and `as` naming a player the agent doesn't own.
 *
 * A lane whose agent jar isn't built is an honest skip. Needs the runner built (`npm run build`).
 *
 *   node tests/e2e/run-macro-mctp.mjs [neoforge|fabric]   (default: both)
 */
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import WebSocket from "ws";
import { provisionModded } from "../../packages/runner/dist/provision/ModdedProvisioner.js";
import { findFreePort } from "../../packages/runner/dist/provision/serverCommon.js";
import { resolveJavaForMc } from "../../packages/runner/dist/provision/jdk.js";
import { resolveModrinth } from "../../packages/runner/dist/provision/modrinth.js";

const LANES = [
  {
    id: "neoforge",
    jar: "agents/server-neoforge/build/libs/agent-server-neoforge-1.21.1.jar",
    boot: (o) => provisionModded({ ...o, loader: "neoforge", mc: "1.21.1", loaderVersion: "21.1.234", mods: [] }),
  },
  {
    id: "fabric",
    jar: "agents/server-fabric/build/libs/agent-server-fabric-1.21.1.jar",
    boot: async (o) => provisionModded({
      ...o, loader: "fabric", mc: "1.21.1", loaderVersion: "0.16.5",
      mods: [{
        path: await resolveModrinth({ project: "fabric-api", loader: "fabric", gameVersion: "1.21.1" }, o.cacheDir),
        as: "fabric-api.jar",
      }],
    }),
  },
];

const MACROS = `
macro greet who
  # Two checks that hold, then a nested macro with one more.
  /tellraw {who} {"text":"Your ticket is #42."}
  expect {who} told "ticket is #42"
  expect {who} not told "ticket is #43" within 1s
  run inner {who}
end

macro inner who
  say inner for {who}
  /tellraw {who} {"text":"Inner done"}
  expect {who} told "inner done"
end

macro wrong who
  # The expect must fail: the player is told #42, not #43. The run carries on.
  /tellraw {who} {"text":"Your ticket is #42."}
  expect {who} told "ticket is #43" within 1s
  -/actor {who} cmd gamemode creative
  /tellraw {who} {"text":"still going"}
end

macro refused who
  # A non-op actor's /gamemode is refused, which stops the macro.
  /actor {who} cmd gamemode creative
  /tellraw {who} {"text":"never"}
end
`;

// --- the runner's judge: pure, and the only source of a verdict -------------------------------------------------

/** Text compared the way the selectors compare it: colour codes stripped, whitespace collapsed, case-folded. */
const normalize = (t) => t.replace(/§./g, "").replace(/\s+/g, " ").trim().toLowerCase();

/** Does one told message satisfy the check's text? `{=name}` captures match one word each. */
function satisfies(message, pattern) {
  if (!/\{=[A-Za-z_]\w*}/.test(pattern)) return normalize(message).includes(normalize(pattern));
  const parts = pattern.split(/\{=[A-Za-z_]\w*}/).map((p) => p.trim().split(/\s+/).filter(Boolean)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"));
  return new RegExp(parts.join("\\s*(\\S+?)\\s*"), "iu").test(normalize(message));
}

/**
 * pass | fail for one expect, from its evidence window alone. A positive check passes when any message in the
 * window satisfies it; a negated one only when none does AND the window ran its full length.
 */
export function judge(check) {
  const seen = check.told.some((t) => satisfies(t.text, check.text));
  if (check.negate) return !seen && check.closedBy === "timeout" ? "pass" : "fail";
  return seen ? "pass" : "fail";
}

// --- plumbing ---------------------------------------------------------------------------------------------------

function connect(url) {
  return new Promise((resolveWs, reject) => {
    const ws = new WebSocket(url, "mctp.v1");
    const pending = new Map();
    const listeners = new Set();
    let nextId = 1;
    ws.on("message", (data) => {
      const env = JSON.parse(String(data));
      if (env.id != null && pending.has(env.id)) {
        pending.get(env.id)(env);
        pending.delete(env.id);
      } else if (env.method) {
        for (const l of listeners) l(env.method, env.params);
      }
    });
    ws.on("open", () => resolveWs({
      call(method, params) {
        const id = nextId++;
        return new Promise((res) => {
          pending.set(id, res);
          ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
        });
      },
      onEvent(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      close() {
        ws.terminate();
      },
    }));
    ws.on("error", reject);
  });
}

const failures = [];
let currentLane = "";
function assert(cond, label) {
  console.log(`  ${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures.push(currentLane ? `${currentLane}: ${label}` : label);
  return cond;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Starts one macro and follows it to its end, printing each step as it closes (the linear live list) and judging
 * every check. Resolves with the steps in order and the run's end.
 */
async function runMacro(client, sid, name, args) {
  const steps = new Map();
  let end;
  let runId;
  const early = [];
  const off = client.onEvent((method, p) => {
    if (runId == null) {
      early.push([method, p]); // events can beat the reply that names the run
      return;
    }
    handle(method, p);
  });
  function handle(method, p) {
    if (p?.runId !== runId) return;
    if (method === "event.macroEnd") {
      end = p;
      console.log(`    ${p.status === "done" ? "■ done" : "■ STOPPED"}: ${p.text}`);
      return;
    }
    if (method !== "event.macroStep") return;
    if (p.phase === "start") {
      steps.set(p.seq, { seq: p.seq, depth: p.depth, kind: p.kind, text: p.text, where: p.where, started: true });
      return;
    }
    const s = steps.get(p.seq) ?? { seq: p.seq };
    Object.assign(s, { status: p.status, detail: p.detail, check: p.check, ended: true });
    if (s.check) s.verdict = judge(s.check);
    steps.set(p.seq, s);
    const mark = s.verdict ? (s.verdict === "pass" ? "✔" : "✘") : s.status === "ok" ? "·" : s.status === "carriedOn" ? "~" : "✘";
    const indent = "  ".repeat(s.depth ?? 0);
    const why = s.verdict === "fail"
      ? `  — told ${s.check.who}: ${s.check.told.map((t) => JSON.stringify(t.text)).join(", ") || "(nothing)"}`
      : s.status !== "ok" && s.status !== "observed" && s.detail ? `  — ${s.detail}` : "";
    console.log(`    ${indent}${mark} ${s.seq} ${s.kind} ${s.text}${why}`);
  }
  console.log(`  ▶ ${name} ${args}`);
  const reply = await client.call("bench.runMacro", { sessionId: sid, name, args });
  if (reply.error) {
    off();
    throw new Error(`bench.runMacro ${name}: ${reply.error.message}`);
  }
  runId = reply.result.runId;
  for (const [m, p] of early) handle(m, p);
  const until = Date.now() + 30000;
  while (!end && Date.now() < until) await sleep(50);
  off();
  return { runId, steps: [...steps.values()].sort((a, b) => a.seq - b.seq), end };
}

// --- the test ---------------------------------------------------------------------------------------------------

async function main() {
  console.log("=== tamper control (judge only) ===");
  const honest = { who: "Bob", text: "ticket is #42", negate: false, closedBy: "match", hint: "pass",
    told: [{ seq: 7, text: "Your ticket is #42." }] };
  assert(judge(honest) === "pass", "an honest window with the message passes");
  assert(judge({ ...honest, told: [] }) === "fail", "the same window without the message fails although hint says pass");
  assert(judge({ ...honest, negate: true, closedBy: "match" }) === "fail", "a negated check whose message arrived fails");
  assert(judge({ ...honest, negate: true, told: [], closedBy: "match" }) === "fail",
    "a negated check whose window was cut short is not a pass");
  assert(judge({ ...honest, text: "listed it as #{=n}", told: [{ seq: 1, text: "The bank listed it as #12." }] }) === "pass",
    "a {=capture} pattern matches one word");

  const wanted = process.argv[2];
  for (const lane of LANES.filter((l) => !wanted || l.id === wanted)) await runLane(lane);
  if (failures.length) {
    console.log(`\nFAILED (${failures.length}): ${failures.join("; ")}`);
    process.exit(1);
  }
  console.log("\nRunner-judged macro spike PASSED");
}

async function runLane(lane) {
  currentLane = lane.id;
  if (!existsSync(lane.jar)) {
    console.log(`\nSKIP ${lane.id}: ${lane.jar} isn't built (cd agents/server-${lane.id} && ./gradlew build)`);
    return;
  }
  console.log(`\n=== ${lane.id} 1.21.1 ===`);
  const instanceDir = mkdtempSync(join(tmpdir(), "mctest-macro-mctp-"));
  const macroDir = mkdtempSync(join(tmpdir(), "mctest-macro-mctp-files-"));
  writeFileSync(join(macroDir, "spike.macro"), MACROS);
  process.env.MCTEST_MACROS = macroDir; // the provisioner's child inherits process.env
  const gamePort = await findFreePort("127.0.0.1", 25800, 25999);
  const agentPort = await findFreePort("127.0.0.1", gamePort + 1, 25999);
  const cacheDir = resolve(".mc-test/cache");
  const javaPath = await resolveJavaForMc("1.21.1", { cacheDir });
  let server;
  let client;
  try {
    server = await lane.boot({
      bindHost: "127.0.0.1", gamePort, instanceDir, cacheDir, javaPath,
      agents: [{ name: `server-${lane.id}`, jarPath: resolve(lane.jar), port: agentPort }],
      eulaAccepted: true, bootTimeoutMs: 300000,
    });
    client = await connect(server.agentEndpoints[0]?.url ?? `ws://127.0.0.1:${agentPort}/mctp`);
    const created = await client.call("session.create", {
      protocolVersion: "1.0",
      client: { name: "macro-mctp-e2e", version: "0.1.0", lang: "ts" },
      requiredCapabilities: ["benchMacros", "fakePlayers"],
    });
    const sid = created.result?.sessionId;
    if (!assert(sid != null, "session.create with requiredCapabilities [benchMacros] is accepted")) {
      throw new Error(JSON.stringify(created.error ?? created));
    }
    const bob = await client.call("player.spawnFake", { sessionId: sid, name: "Bob", persist: true });
    if (!bob.result?.ok) throw new Error(`spawnFake: ${JSON.stringify(bob.error)}`);
    await sleep(500);

    console.log("\n--- 1. a passing macro ---");
    const greet = await runMacro(client, sid, "greet", "Bob");
    assert(greet.end?.status === "done", "greet ends done");
    assert(greet.steps.every((s) => s.started && s.ended), "every step started and ended exactly once");
    assert(greet.steps.map((s) => `${s.depth}:${s.kind}`).join(" ") ===
      "0:command 0:expect 0:expect 0:run 1:say 1:command 1:expect",
      `steps in order, nested ones a level deeper (${greet.steps.map((s) => `${s.depth}:${s.kind}`).join(" ")})`);
    const greetChecks = greet.steps.filter((s) => s.check);
    assert(greetChecks.length === 3 && greetChecks.every((s) => s.verdict === "pass"), "the runner judges all 3 checks pass");
    assert(greetChecks[1].check.negate && greetChecks[1].check.closedBy === "timeout",
      "the negated check watched its whole 1 s window");

    console.log("\n--- 2. an expect that must fail ---");
    const wrong = await runMacro(client, sid, "wrong", "Bob");
    const wrongCheck = wrong.steps.find((s) => s.kind === "expect");
    assert(wrongCheck?.verdict === "fail", "the runner judges the #43 check fail");
    assert(wrongCheck?.check.told.some((t) => t.text.includes("#42")), "its evidence shows what Bob was told instead (#42)");
    assert(wrong.steps.find((s) => s.text?.startsWith("-/actor"))?.status === "carriedOn", "the -/ refusal is carriedOn");
    assert(wrong.end?.status === "done" && wrong.steps.at(-1)?.status === "ok", "the run carried on to its last step");

    console.log("\n--- 3. a refused command stops the run ---");
    const refused = await runMacro(client, sid, "refused", "Bob");
    assert(refused.steps[0]?.status === "failed", "the refused /actor step ends failed");
    assert(refused.end?.status === "stopped", "the run ends stopped");
    assert(refused.steps.length === 1, "the step after it never started");

    console.log("\n--- 4. hints vs verdicts (live) ---");
    const all = [...greet.steps, ...wrong.steps].filter((s) => s.check);
    assert(all.every((s) => s.check.hint === s.verdict), "with an honest agent, its hint and the runner's verdict agree");

    console.log("\n--- 5. refused requests ---");
    const unknown = await client.call("bench.runMacro", { sessionId: sid, name: "nope" });
    assert(unknown.error?.code === -32602, `an unknown macro is invalidParams (${unknown.error?.message})`);
    const notOurs = await client.call("bench.runMacro", { sessionId: sid, name: "greet", args: "Bob", as: "Notch" });
    assert(notOurs.error?.code === -32602, `as: a player the agent doesn't own is refused (${notOurs.error?.message})`);
  } finally {
    client?.close();
    await server?.stop().catch(() => {});
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
