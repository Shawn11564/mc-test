#!/usr/bin/env node
/**
 * /macro real-boot E2E (docs/MACROS.md): boots a real dedicated server per loader with its server agent and
 * MCTEST_MACROS pointing at a scratch folder, joins a real opped client (Mineflayer "Tester"), and runs macros
 * through the real dispatcher, asserting on the `[macro Tester] …` log lines:
 *
 *   1. a macro with arguments runs its commands in order, as the invoker, and drives an actor;
 *   2. `expect <who> told` passes on a message the actor was told; a `{=capture}` takes a word of one and a later
 *      step uses it;
 *   3. an actor command that fails (a non-op actor's /gamemode) STOPS the macro: the next step never runs;
 *      `-/` carries on past a failure;
 *   4. recording: commands typed between `record start` and `record save` become a macro with the actor's name
 *      as a parameter, and replaying it for another actor works;
 *   5. a file edited while the server runs is picked up without /macro reload.
 *
 * Loaders whose agent jar is not built are honest skips. Needs the runner built (`npm run build`).
 *
 *   node tests/e2e/run-bench-macros.mjs [fabric|neoforge]
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import WebSocket from "ws";
import { createBot } from "mineflayer";
import { provisionModded } from "../../packages/runner/dist/provision/ModdedProvisioner.js";
import { findFreePort } from "../../packages/runner/dist/provision/serverCommon.js";
import { resolveJavaForMc } from "../../packages/runner/dist/provision/jdk.js";
import { resolveModrinth } from "../../packages/runner/dist/provision/modrinth.js";

const LANES = [
  {
    id: "fabric", mc: "1.21.1",
    jar: "agents/server-fabric/build/libs/agent-server-fabric-1.21.1.jar",
    boot: async (o) => provisionModded({
      ...o, loader: "fabric", mc: "1.21.1", loaderVersion: "0.16.5",
      mods: [{
        path: await resolveModrinth({ project: "fabric-api", loader: "fabric", gameVersion: "1.21.1" }, o.cacheDir),
        as: "fabric-api.jar",
      }],
    }),
  },
  {
    id: "neoforge", mc: "1.21.1",
    jar: "agents/server-neoforge/build/libs/agent-server-neoforge-1.21.1.jar",
    boot: (o) => provisionModded({ ...o, loader: "neoforge", mc: "1.21.1", loaderVersion: "21.1.234", mods: [] }),
  },
];

const MACROS = `
macro give.to who n=1 item=minecraft:diamond
  # Gives {who} {n} of {item} and has them say so.
  /give {who} {item} {n}
  /actor {who} cmd me got {n} from {me}
end

macro ticket who
  /tellraw {who} {"text":"Your ticket is #42."}
  expect {who} told "ticket is #42"
  expect {who} not told "ticket is #43" within 1s
  waitfor {who} told "ticket is #{=number}"
  /actor {who} cmd me holds ticket {number}
end

macro refused who
  /actor {who} cmd me tries gamemode
  /actor {who} cmd gamemode creative
  /actor {who} cmd me should never get here
end

macro forgiving who
  -/actor {who} cmd gamemode creative
  /actor {who} cmd me carried on
end
`;

function connect(url) {
  return new Promise((resolveWs, reject) => {
    const ws = new WebSocket(url, "mctp.v1");
    const pending = new Map();
    let nextId = 1;
    ws.on("message", (data) => {
      const env = JSON.parse(String(data));
      if (env.id != null && pending.has(env.id)) {
        pending.get(env.id)(env);
        pending.delete(env.id);
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
      close() {
        ws.terminate();
      },
    }));
    ws.on("error", reject);
  });
}

const failures = [];
function assert(cond, label) {
  console.log(`  ${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures.push(label);
  return cond;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runLane(lane) {
  console.log(`\n=== ${lane.id} (${lane.mc}) ===`);
  const instanceDir = mkdtempSync(join(tmpdir(), `mctest-macros-${lane.id}-`));
  const macroDir = mkdtempSync(join(tmpdir(), `mctest-macro-files-${lane.id}-`));
  writeFileSync(join(macroDir, "e2e.macro"), MACROS);
  process.env.MCTEST_MACROS = macroDir; // the provisioner's child inherits process.env
  const gamePort = await findFreePort("127.0.0.1", 25800, 25999);
  const agentPort = await findFreePort("127.0.0.1", gamePort + 1, 25999);
  const cacheDir = resolve(".mc-test/cache");
  const javaPath = await resolveJavaForMc(lane.mc, { cacheDir });
  const log = [];
  let server;
  let bot;
  try {
    server = await lane.boot({
      bindHost: "127.0.0.1", gamePort, instanceDir, cacheDir, javaPath,
      agents: [{ name: `server-${lane.id}`, jarPath: resolve(lane.jar), port: agentPort }],
      ops: ["Tester"], // the actors are NOT ops, so their /gamemode is refused
      eulaAccepted: true,
      bootTimeoutMs: 300000,
      onLog: (chunk) => log.push(...String(chunk).split(/\r?\n/)),
    });
    const booted = log.length;
    const seen = (re) => log.slice(booted).some((l) => re.test(l));
    const waitLog = async (re, ms = 10000) => {
      const until = Date.now() + ms;
      while (!seen(re) && Date.now() < until) await sleep(100);
      return seen(re);
    };
    assert(log.some((l) => l.includes("Macros are read from") && l.includes(macroDir.split(/[\\/]/).pop())),
      "the agent reads MCTEST_MACROS");

    const mctp = await connect(server.agentEndpoints[0]?.url ?? `ws://127.0.0.1:${agentPort}/mctp`);
    const s = await mctp.call("session.create", {
      protocolVersion: "1.0", client: { name: "bench-macros-e2e", version: "0.1.0", lang: "ts" },
      requiredCapabilities: ["fakePlayers"],
    });
    const sid = s.result.sessionId;
    for (const name of ["Carol", "Dave"]) {
      const r = await mctp.call("player.spawnFake", { sessionId: sid, name, persist: true });
      assert(r.result?.ok === true, `spawn ${name}`);
    }

    bot = await new Promise((res, rej) => {
      const b = createBot({ host: "127.0.0.1", port: gamePort, username: "Tester", version: "1.21.1", auth: "offline" });
      b.once("spawn", () => res(b));
      b.once("kicked", (r) => rej(new Error(`kicked: ${JSON.stringify(r)}`)));
      b.once("error", rej);
      setTimeout(() => rej(new Error("Tester did not join within 30s")), 30000);
    });
    bot.on("error", () => {});
    const told = [];
    bot.on("messagestr", (m) => told.push(m));
    await sleep(1000);

    // 1. arguments, order, the invoker, an actor.
    bot.chat("/m give.to Carol n=3");
    assert(await waitLog(/\[macro Tester\] done give\.to who=Carol n=3 item=minecraft:diamond/),
      "give.to ran to the end");
    assert(seen(/\[macro Tester\] step \/give Carol minecraft:diamond 3/), "the {n} and {item} placeholders were filled");
    assert(seen(/\* Carol got 3 from Tester/), "the /actor line drove Carol, and {me} is the invoker");
    bot.chat("/macro again Dave");
    assert(await waitLog(/\* Dave got 3 from Tester/), "/macro again Dave keeps n=3 and swaps who");
    // A macro finishes the tick after its last command; starting another before that is "Already running".
    await waitLog(/\[macro Tester\] done give\.to who=Dave/);

    // 2. told + captures.
    bot.chat("/m ticket Carol");
    assert(await waitLog(/\[macro Tester\] done ticket/, 15000), "ticket ran to the end");
    assert(seen(/\[macro Tester\] pass Carol was told "ticket is #42"/), "expect told passes on Carol's message");
    assert(seen(/\[macro Tester\] pass Carol wasn't told "ticket is #43"/), "expect not told passes when it never comes");
    assert(seen(/\* Carol holds ticket 42/), "the {=number} capture fed the next step");

    // 3. a failed actor command stops the macro; -/ carries on.
    bot.chat("/m refused Carol");
    assert(await waitLog(/\[macro Tester\] stopped refused who=Carol: \/actor Carol cmd gamemode creative failed/),
      "a refused actor command stops the macro");
    await sleep(1500);
    assert(seen(/\* Carol tries gamemode/) && !seen(/should never get here/), "…and the step after it never ran");
    bot.chat("/m forgiving Carol");
    assert(await waitLog(/\* Carol carried on/), "-/ carries on past the same failure");

    // 4. recording.
    bot.chat("/macro record start");
    await sleep(300);
    bot.chat("/actor Carol cmd me was recorded");
    await waitLog(/\* Carol was recorded/);
    bot.chat("/macro record save rec.test");
    await sleep(1500);
    const recorded = existsSync(join(macroDir, "recorded.macro")) ? readFileSync(join(macroDir, "recorded.macro"), "utf8") : "";
    assert(/macro rec\.test who=Carol/.test(recorded), `record save wrote a macro with Carol as a parameter (${JSON.stringify(recorded)})`);
    assert(/\/actor \{who\} cmd me was recorded/.test(recorded), "…holding the typed command");
    bot.chat("/m rec.test Dave");
    assert(await waitLog(/\* Dave was recorded/), "the recorded macro replays for Dave");
    await waitLog(/\[macro Tester\] done rec\.test/);

    // 5. an edited file is picked up without /macro reload.
    writeFileSync(join(macroDir, "late.macro"), "macro late who\n  /actor {who} cmd me arrived late\nend\n");
    await sleep(1100);
    bot.chat("/m late Carol");
    assert(await waitLog(/\* Carol arrived late/), "a macro file added while running is found at once");

    const errors = log.slice(booted).filter((l) => /ERROR|Exception/.test(l));
    assert(errors.length === 0, `no errors in the server log (${errors.slice(0, 5).join(" | ")})`);
    if (failures.length > 0) {
      console.log("  what Tester was told, for triage:");
      console.log(told.map((l) => `    > ${l}`).join("\n"));
      console.log("  the macro lines, for triage:");
      console.log(log.slice(booted).filter((l) => /\[macro |\[actor |\* /.test(l)).map((l) => `    | ${l}`).join("\n"));
    }
    mctp.close();
  } catch (e) {
    failures.push(`${lane.id}: ${e.message}`);
    console.log(`  ✗ lane error: ${e.message}`);
    console.log(log.slice(-60).map((l) => `    | ${l}`).join("\n"));
    console.log(`  (instance kept for triage: ${instanceDir})`);
    try {
      bot?.quit();
      await server?.stop();
    } catch { /* best-effort */ }
    return;
  }
  bot?.quit();
  try {
    await server.stop();
  } catch { /* best-effort */ }
  for (const dir of [instanceDir, macroDir]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch { /* Windows file locks */ }
  }
}

const only = process.argv[2];
const lanes = LANES.filter((l) => !only || l.id === only);
const built = lanes.filter((l) => existsSync(l.jar));
for (const lane of lanes.filter((l) => !existsSync(l.jar))) {
  console.log(`○ SKIP ${lane.id} — ${lane.jar} not built (acceptance-only)`);
}
for (const lane of built) {
  await runLane(lane);
}
if (built.length === 0) {
  console.log("no agent jars built; nothing verified (honest skip)");
  process.exit(0);
}
console.log(failures.length === 0
  ? "\nALL bench-macros E2E assertions passed"
  : `\n${failures.length} FAILURES:\n - ${failures.join("\n - ")}`);
process.exit(failures.length === 0 ? 0 : 1);
