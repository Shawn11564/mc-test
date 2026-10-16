#!/usr/bin/env node
/**
 * Spec/42 bench-actors real-boot E2E — the live proof the spec's checklist demands. Boots a real
 * dedicated server per loader (fabric / neoforge / forge / PAPER for the reflective bukkit native
 * backend) with its server agent, then drives raw MCTP over WebSocket to assert the lifecycle a
 * step file cannot express:
 *
 *   1. handshake token: wrong token → -32602 with NO session; right token → granted, and the
 *      fakePlayers detail advertises `persist:true` + `list:true` + `backend:"native"`.
 *   2. spawn "Rival" persist:true + "Temp" session-scoped; player.list shows both online.
 *   3. player.act (chat) drives Rival.
 *   3a. tab completion: a real client (Mineflayer, opped) asks the server to complete /actor lines —
 *      actor names (never real players), and after `cmd` the forwarded command as THAT actor sees it
 *      (op Rival is offered `gamemode`, non-op Temp isn't).
 *   3b. click-text (spec/42): op Rival, have it place a chest with two diamond stacks in it and
 *      open it, then read the menu back over `player.menu` and click a slot BY THE TEXT THE GUI
 *      SHOWS — including the two refusals that matter (no match → ELEMENT_NOT_FOUND, more than one
 *      match without an index → AMBIGUOUS_SELECTOR).
 *   4. DROP the socket (the spec/41 kill path) → reconnect → Rival is STILL online (persistence),
 *      Temp is gone (session-scoped teardown untouched), and Rival is drivable BY NAME from the
 *      new session (cross-session addressing).
 *   5. real players stay un-puppetable: acting on an unknown/real name → -32602.
 *   6. despawnFake removes Rival; the roster is empty.
 *
 * Loaders whose agent jar is not built are HONEST SKIPS (printed, not failures), matching
 * run-modded-server-boot.mjs. Needs the runner built (`npm run build`) and network for first-boot
 * downloads.
 *
 *   node tests/e2e/run-bench-actors.mjs
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import WebSocket from "ws";
import { createBot } from "mineflayer";
import { provisionModded } from "../../packages/runner/dist/provision/ModdedProvisioner.js";
import { provisionPaper } from "../../packages/runner/dist/provision/PaperProvisioner.js";
import { findFreePort } from "../../packages/runner/dist/provision/serverCommon.js";
import { resolveJavaForMc } from "../../packages/runner/dist/provision/jdk.js";
import { resolveModrinth } from "../../packages/runner/dist/provision/modrinth.js";

const TOKEN = "bench-actors-e2e-token";
process.env.MCTEST_AGENT_TOKEN = TOKEN; // the provisioner's child spawn inherits process.env

const LANES = [
  {
    id: "fabric", mc: "1.21.1",
    jar: "agents/server-fabric/build/libs/agent-server-fabric-1.21.1.jar",
    // The fabric agent hard-depends on fabric-api (its callbacks live there).
    boot: async (o) => provisionModded({
      ...o, loader: "fabric", mc: "1.21.1", loaderVersion: "0.16.5",
      mods: [{
        path: await resolveModrinth(
          { project: "fabric-api", loader: "fabric", gameVersion: "1.21.1" }, o.cacheDir),
        as: "fabric-api.jar",
      }],
    }),
  },
  {
    id: "neoforge", mc: "1.21.1",
    jar: "agents/server-neoforge/build/libs/agent-server-neoforge-1.21.1.jar",
    boot: (o) => provisionModded({ ...o, loader: "neoforge", mc: "1.21.1", loaderVersion: "21.1.234", mods: [] }),
  },
  {
    id: "forge", mc: "1.20.1",
    jar: "agents/server-forge/build/libs/agent-server-forge-1.20.1.jar",
    boot: (o) => provisionModded({ ...o, loader: "forge", mc: "1.20.1", loaderVersion: "47.3.39", mods: [] }),
  },
  {
    id: "paper-native", mc: "1.21.1",
    jar: "agents/server-bukkit/build/libs/mc-test-agent-bukkit.jar",
    boot: (o) => provisionPaper({ ...o, mc: "1.21.1", plugins: [] }),
  },
];

// --- tiny raw MCTP client -----------------------------------------------------------------

function connect(url) {
  return new Promise((resolveWs, reject) => {
    const ws = new WebSocket(url, "mctp.v1");
    const pending = new Map();
    let nextId = 1;
    ws.on("message", (data) => {
      const env = JSON.parse(String(data));
      if (env.id != null && pending.has(env.id)) {
        const { res } = pending.get(env.id);
        pending.delete(env.id);
        res(env);
      }
    });
    ws.on("open", () => resolveWs({
      ws,
      call(method, params) {
        const id = nextId++;
        return new Promise((res) => {
          pending.set(id, { res });
          ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
        });
      },
      close() {
        ws.terminate(); // abrupt drop — the exact "controller died" path
      },
    }));
    ws.on("error", reject);
  });
}

async function createSession(client, token) {
  return client.call("session.create", {
    protocolVersion: "1.0",
    client: { name: "bench-actors-e2e", version: "0.1.0", lang: "ts" },
    requiredCapabilities: ["fakePlayers"],
    ...(token ? { auth: { token } } : {}),
  });
}

// --- assertions ---------------------------------------------------------------------------

const failures = [];
function assert(cond, label) {
  console.log(`  ${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures.push(label);
  return cond;
}

/** Joins a real client and returns the completion texts the server offers for each line. */
async function checkCompletions(lane, gamePort) {
  const bot = createBot({ host: "127.0.0.1", port: gamePort, username: "Tabber", version: lane.mc, auth: "offline" });
  try {
    await new Promise((resolveSpawn, reject) => {
      bot.once("spawn", resolveSpawn);
      bot.once("kicked", (reason) => reject(new Error(`Tabber kicked: ${JSON.stringify(reason)}`)));
      bot.once("error", reject);
      setTimeout(() => reject(new Error("Tabber did not join within 30s")), 30000);
    });
    // The client only gets the op command tree once it's in; give the permission packet a moment.
    await new Promise((r) => setTimeout(r, 1000));
    const complete = async (line, { expectEmpty = false } = {}) => {
      try {
        const matches = await bot.tabComplete(line, false, false, expectEmpty ? 3000 : 10000);
        return matches.map((m) => (typeof m === "string" ? m : m.match));
      } catch (e) {
        // Paper sends no reply at all when there is nothing to suggest; the vanilla server sends an
        // empty one. Only lines that should complete to nothing may be answered with silence.
        if (expectEmpty && /did not fire/.test(e.message)) return [];
        throw e;
      }
    };

    const root = await complete("/actor Ri");
    assert(root.includes("Rival"), `"/actor Ri" offers Rival (got ${JSON.stringify(root)})`);
    const everyone = await complete("/actor ");
    assert(everyone.includes("Temp") && everyone.includes("spawn"), `"/actor " offers actors + subcommands (got ${JSON.stringify(everyone)})`);
    assert(!everyone.includes("Tabber"), "a real player is never offered as an actor");
    const remove = await complete("/actor remove R");
    assert(remove.includes("Rival"), `"/actor remove R" offers Rival (got ${JSON.stringify(remove)})`);

    const cmd = await complete("/actor Rival cmd gamem");
    assert(cmd.includes("gamemode"), `"cmd gamem" offers gamemode to op Rival (got ${JSON.stringify(cmd)})`);
    const slashed = await complete("/actor Rival cmd /gamem");
    assert(slashed.some((m) => m.replace(/^\//, "") === "gamemode"), `"cmd /gamem" offers gamemode (got ${JSON.stringify(slashed)})`);
    const arg = await complete("/actor Rival cmd gamemode cr");
    assert(arg.includes("creative"), `"cmd gamemode cr" offers creative (got ${JSON.stringify(arg)})`);
    const nonOp = await complete("/actor Temp cmd gamem", { expectEmpty: true });
    assert(!nonOp.includes("gamemode"), `non-op Temp is not offered gamemode (got ${JSON.stringify(nonOp)})`);
    const stranger = await complete("/actor NotAnActor cmd gamem", { expectEmpty: true });
    assert(stranger.length === 0, `a non-actor gets no command completions (got ${JSON.stringify(stranger)})`);
  } finally {
    bot.quit();
  }
}

async function runLane(lane) {
  console.log(`\n=== ${lane.id} (${lane.mc}) ===`);
  const instanceDir = mkdtempSync(join(tmpdir(), `mctest-actors-${lane.id}-`));
  const gamePort = await findFreePort("127.0.0.1", 25800, 25999);
  const agentPort = await findFreePort("127.0.0.1", gamePort + 1, 25999);
  const cacheDir = resolve(".mc-test/cache");
  const javaPath = await resolveJavaForMc(lane.mc, { cacheDir });
  const bootLog = [];
  let server;
  try {
    server = await lane.boot({
      bindHost: "127.0.0.1",
      gamePort,
      instanceDir,
      cacheDir,
      javaPath,
      agents: [{ name: lane.id === "paper-native" ? "server-bukkit" : `server-${lane.id}`, jarPath: resolve(lane.jar), port: agentPort }],
      // The click-text step drives vanilla commands AS the actor (setblock/item replace), which
      // needs op — the fake joins with the deterministic offline UUID writeOps() grants.
      // Tabber is the real (Mineflayer) client that asks for /actor completions; /actor needs op.
      ops: ["Rival", "Tabber"],
      eulaAccepted: true,
      bootTimeoutMs: 300000,
      onLog: (line) => bootLog.push(line),
    });
    const url = server.agentEndpoints[0]?.url ?? `ws://127.0.0.1:${agentPort}/mctp`;

    // 1. token: wrong → -32602 + no session; right → granted with the spec/42 detail.
    const probe = await connect(url);
    const refused = await createSession(probe, "wrong-token");
    assert(refused.error?.code === -32602, "wrong token refused -32602");
    const noSession = await probe.call("player.list", { sessionId: "s_nope" });
    assert(noSession.error != null, "no session exists after refusal");
    probe.close();

    const c1 = await connect(url);
    const s1 = await createSession(c1, TOKEN);
    if (!assert(s1.result?.ok === true, "session granted with the right token")) throw new Error("no session");
    const sid1 = s1.result.sessionId;
    const detail = s1.result.capabilityDetails?.fakePlayers ?? {};
    assert(detail.backend === "native", `backend is native (got ${detail.backend})`);
    assert(detail.persist === true && detail.list === true, "detail advertises persist+list");
    assert(detail.menu === true, "detail advertises menu (click-text)");
    assert((detail.verbs ?? []).includes("clickMenuText"), "verbs advertise clickMenuText");

    // 2. spawn a persistent actor + a session-scoped one; both listed online.
    const spawn = await c1.call("player.spawnFake", { sessionId: sid1, name: "Rival", persist: true });
    assert(spawn.result?.ok === true, "spawn Rival persist:true");
    const spawn2 = await c1.call("player.spawnFake", { sessionId: sid1, name: "Temp" });
    assert(spawn2.result?.ok === true, "spawn Temp session-scoped");
    const list1 = await c1.call("player.list", { sessionId: sid1 });
    const rows1 = list1.result?.players ?? [];
    assert(rows1.some((p) => p.name === "Rival" && p.persist === true && p.online === true), "list: Rival online+persist");
    assert(rows1.some((p) => p.name === "Temp" && p.persist === false && p.online === true), "list: Temp online session-scoped");

    // 3. drive a verb.
    const chat = await c1.call("player.act", { sessionId: sid1, name: "Rival", verb: "chat", args: { message: "gl hf" } });
    assert(chat.result?.ok === true, "act chat as Rival");

    // 3a. tab completion, asked over the real client protocol.
    await checkCompletions(lane, gamePort);

    // 3b. click-text: read a real open GUI back, then click a slot by the text it shows.
    const at = rows1.find((p) => p.name === "Rival")?.position;
    if (!assert(at != null, "Rival reports a position")) throw new Error("no position");
    const bx = Math.floor(at.x) + 1;
    const by = Math.floor(at.y);
    const bz = Math.floor(at.z);
    const asRival = (command) =>
      c1.call("player.act", { sessionId: sid1, name: "Rival", verb: "command", args: { command } });
    await asRival(`setblock ${bx} ${by} ${bz} minecraft:chest`);
    // `item replace block` has the same syntax on 1.20.1 and 1.21.1 — no NBT, nothing to fork.
    await asRival(`item replace block ${bx} ${by} ${bz} container.0 with minecraft:diamond 3`);
    await asRival(`item replace block ${bx} ${by} ${bz} container.1 with minecraft:diamond 1`);
    const opened = await c1.call("player.act",
      { sessionId: sid1, name: "Rival", verb: "interactBlock", args: { x: bx, y: by, z: bz } });
    assert(opened.result?.ok === true, "Rival opened the chest");

    const menu = await c1.call("player.menu", { sessionId: sid1, name: "Rival" });
    const slots = menu.result?.slots ?? [];
    assert(menu.result?.open === true, "player.menu reports an open menu");
    assert(slots.some((s) => s.slot === 0 && s.item === "minecraft:diamond" && s.count === 3),
      `menu slot 0 is 3x diamond (got ${JSON.stringify(slots)})`);
    assert(slots.some((s) => s.slot === 0 && /diamond/i.test(s.name)),
      "menu slot 0 carries the display name the GUI shows");

    const miss = await c1.call("player.act", { sessionId: sid1, name: "Rival",
      verb: "clickMenuText", args: { text: "wither skeleton skull" } });
    assert(miss.error?.code === -32000, `no match → ELEMENT_NOT_FOUND (got ${miss.error?.code})`);
    assert(/diamond/i.test(miss.error?.message ?? ""), "the miss message says what the menu DOES have");

    const tie = await c1.call("player.act", { sessionId: sid1, name: "Rival",
      verb: "clickMenuText", args: { text: "diamond" } });
    assert(tie.error?.code === -32001, `two matches → AMBIGUOUS_SELECTOR (got ${tie.error?.code})`);

    const clicked = await c1.call("player.act", { sessionId: sid1, name: "Rival",
      verb: "clickMenuText", args: { text: "diamond", index: 1 } });
    assert(clicked.result?.ok === true, `clickMenuText index:1 clicked (${clicked.error?.message ?? ""})`);
    assert(/slot 1/.test(clicked.result?.detail ?? ""), `detail names the slot (got ${clicked.result?.detail})`);

    const after = await c1.call("player.menu", { sessionId: sid1, name: "Rival" });
    const left = after.result?.slots ?? [];
    assert(left.some((s) => s.slot === 0) && !left.some((s) => s.slot === 1),
      `the clicked slot emptied, the other did not (got ${JSON.stringify(left.map((s) => s.slot))})`);

    // 4. DROP the socket; persistence is the whole point.
    c1.close();
    await new Promise((r) => setTimeout(r, 2000)); // let the agent run its socket-close teardown
    const c2 = await connect(url);
    const s2 = await createSession(c2, TOKEN);
    const sid2 = s2.result.sessionId;
    const list2 = await c2.call("player.list", { sessionId: sid2 });
    const rows2 = list2.result?.players ?? [];
    assert(rows2.some((p) => p.name === "Rival" && p.online === true), "Rival SURVIVED the socket drop");
    assert(!rows2.some((p) => p.name === "Temp" && p.online), "Temp (session-scoped) was torn down");
    const chat2 = await c2.call("player.act", { sessionId: sid2, name: "Rival", verb: "chat", args: { message: "still here" } });
    assert(chat2.result?.ok === true, "Rival drivable BY NAME from a fresh session");

    // 5. the guard: an un-owned name never resolves.
    const guard = await c2.call("player.act", { sessionId: sid2, name: "NotAnActor", verb: "chat", args: { message: "x" } });
    assert(guard.error?.code === -32602, "unknown/real names are un-puppetable (-32602)");

    // 6. despawn from the second session; roster empties.
    const despawn = await c2.call("player.despawnFake", { sessionId: sid2, name: "Rival" });
    assert(despawn.result?.ok === true, "despawn Rival from the new session");
    const list3 = await c2.call("player.list", { sessionId: sid2 });
    assert((list3.result?.players ?? []).every((p) => !p.online), "roster shows no online actors after despawn");
    c2.close();
  } catch (e) {
    failures.push(`${lane.id}: ${e.message}`);
    console.log(`  ✗ lane error: ${e.message}`);
    console.log(bootLog.slice(-40).map((l) => `    | ${l}`).join("\n"));
    console.log(`  (instance kept for triage: ${instanceDir})`);
    try {
      await server?.stop();
    } catch { /* best-effort */ }
    return;
  }
  try {
    await server.stop();
  } catch { /* best-effort */ }
  try {
    rmSync(instanceDir, { recursive: true, force: true });
  } catch { /* Windows file locks; the OS temp dir is fine */ }
}

const built = LANES.filter((l) => existsSync(l.jar));
for (const lane of LANES.filter((l) => !existsSync(l.jar))) {
  console.log(`○ SKIP ${lane.id} — ${lane.jar} not built (acceptance-only)`);
}
const only = process.argv[2];
for (const lane of built) {
  if (only && lane.id !== only) continue;
  await runLane(lane);
}
if (built.length === 0) {
  console.log("no agent jars built; nothing verified (honest skip)");
  process.exit(0);
}
console.log(failures.length === 0
  ? "\nALL bench-actors E2E assertions passed"
  : `\n${failures.length} FAILURES:\n - ${failures.join("\n - ")}`);
process.exit(failures.length === 0 ? 0 : 1);
