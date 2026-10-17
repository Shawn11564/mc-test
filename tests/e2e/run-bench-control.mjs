#!/usr/bin/env node
/**
 * Bench-actor view/control real-boot E2E: `/actor <name> view`, `/actor <name> control` and `/actor back`
 * (agents/server-neoforge/.../mappings/ActorControl.java, and the fabric twin). Boots a real dedicated server per
 * loader with its server agent, joins a REAL client over the game protocol (Mineflayer, opped "Tester"), and
 * checks what the client and the server see:
 *
 *   1. control: the client is handed the actor (a respawn into its position, its inventory, its game mode),
 *      walking moves the ACTOR on the server, chat and commands come from the actor, the actor can't be driven
 *      by player.act meanwhile, and Tester stays online the whole time (parked).
 *   2. back (typed by a NON-op actor): the client is Tester again, where and as it was (position, inventory, game
 *      mode), and the actor is an actor again where the client left it, drivable over MCTP.
 *   3. view: spectator with the camera on the actor; back restores game mode and position.
 *   4. a real player can't be taken over; an actor already controlled can't be taken twice.
 *   5. disconnect while controlling: the actor comes back as an actor where it was left, and Tester, logging in
 *      again, is where it was parked, as it was.
 *   6. the parked player kicked while controlling: the client goes too, and the actor comes back.
 *
 * Loaders whose agent jar is not built are honest skips. Needs the runner built (`npm run build`).
 *
 *   node tests/e2e/run-bench-control.mjs [fabric|neoforge]
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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

// --- tiny raw MCTP client -----------------------------------------------------------------

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

// --- helpers -------------------------------------------------------------------------------

const failures = [];
function assert(cond, label) {
  console.log(`  ${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures.push(label);
  return cond;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, fn, ms = 10000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${label}`);
    await sleep(100);
  }
}

function join_(gamePort, username) {
  const bot = createBot({ host: "127.0.0.1", port: gamePort, username, version: "1.21.1", auth: "offline" });
  return new Promise((res, rej) => {
    bot.once("spawn", () => res(bot));
    bot.once("kicked", (reason) => rej(new Error(`${username} kicked: ${JSON.stringify(reason)}`)));
    bot.once("error", rej);
    bot.on("error", () => {}); // a write racing a kick; the kick itself is what the test reads
    setTimeout(() => rej(new Error(`${username} did not join within 30s`)), 30000);
  });
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const items = (bot) => bot.inventory.items().map((i) => `${i.name}x${i.count}`).sort().join(",");

/** The next respawn the client gets, and the position packet after it. */
function nextRespawn(bot) {
  return new Promise((res) => {
    bot.once("respawn", () => {
      bot.once("forcedMove", () => res(bot.entity.position.clone()));
    });
  });
}

async function runLane(lane) {
  console.log(`\n=== ${lane.id} (${lane.mc}) ===`);
  const instanceDir = mkdtempSync(join(tmpdir(), `mctest-control-${lane.id}-`));
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
      // Tester is the human. Rival is an op actor (it does the kicking in step 6). Carol is NOT an op, so
      // /actor back typed as Carol proves the controller keeps /actor.
      ops: ["Tester", "Rival"],
      eulaAccepted: true,
      bootTimeoutMs: 300000,
      onLog: (chunk) => log.push(...String(chunk).split(/\r?\n/)),
    });
    const sawLog = (re) => log.some((l) => re.test(l));
    const mctp = await connect(server.agentEndpoints[0]?.url ?? `ws://127.0.0.1:${agentPort}/mctp`);
    const s = await mctp.call("session.create", {
      protocolVersion: "1.0", client: { name: "bench-control-e2e", version: "0.1.0", lang: "ts" },
      requiredCapabilities: ["fakePlayers"],
    });
    if (!assert(s.result?.ok === true, "MCTP session")) throw new Error("no session");
    const sid = s.result.sessionId;
    const roster = async () => (await mctp.call("player.list", { sessionId: sid })).result?.players ?? [];
    const carol = async () => (await roster()).find((p) => p.name === "Carol");

    bot = await join_(gamePort, "Tester");
    await sleep(1000); // the op command tree arrives after spawn
    const say = (line) => bot.chat(line);
    const told = [];
    bot.on("messagestr", (m) => told.push(m));

    // Setup: Tester in creative holding a stick; Carol (survival, 5 diamonds) far enough away that the client
    // has to be sent new chunks.
    say("/gamemode creative");
    say("/clear");
    say("/give Tester minecraft:stick 1");
    await waitFor("Tester's stick", () => items(bot) === "stickx1");
    await waitFor("creative", () => bot.game.gameMode === "creative");
    const home = bot.entity.position.clone();
    for (const name of ["Carol", "Rival"]) {
      const r = await mctp.call("player.spawnFake", {
        sessionId: sid, name, persist: true, at: { x: home.x, y: home.y, z: home.z },
      });
      assert(r.result?.ok === true, `spawn ${name}`);
    }
    say(`/spreadplayers ${Math.floor(home.x) + 150} ${Math.floor(home.z)} 0 3 false Carol`);
    say("/give Carol minecraft:diamond 5");
    say("/gamemode survival Carol"); // the provisioner's default is creative, like Tester's
    const carolAt = await waitFor("Carol moved away", async () => {
      const c = await carol();
      return c?.online && flat(c.position, home) > 100 ? c.position : null;
    });
    await sleep(1500); // let Carol land

    // 4. the guard: a real player is never taken over.
    say("/actor Tester control");
    const refusal = await waitFor("the refusal", () => told.find((m) => /real players can't/.test(m)), 5000)
      .catch(() => null);
    assert(refusal != null, `taking over a real player is refused (${refusal})`);

    // 1. control.
    const handed = nextRespawn(bot);
    say("/actor Carol control");
    const atCarol = await Promise.race([handed, sleep(15000).then(() => null)]);
    if (!assert(atCarol != null, "the client was sent a respawn + position")) throw new Error("no hand-over");
    const carolNow = (await carol()).position;
    assert(dist(atCarol, carolNow) < 1.5, `the client is where Carol is (${fmt(atCarol)} vs ${fmt(carolNow)})`);
    await waitFor("Carol's inventory", () => items(bot) === "diamondx5", 5000).catch(() => {});
    assert(items(bot) === "diamondx5", `the client holds Carol's inventory (got ${items(bot)})`);
    await waitFor("survival", () => bot.game.gameMode === "survival", 5000).catch(() => {});
    assert(bot.game.gameMode === "survival", `the client has Carol's game mode (got ${bot.game.gameMode})`);
    // A client reads its own game mode from its own tab entry (still Tester's): the agent re-labels it.
    await waitFor("own tab entry", () => bot.players.Tester?.gamemode === 0, 5000).catch(() => {});
    assert(bot.players.Tester?.gamemode === 0, `the client's own tab entry says survival (got ${bot.players.Tester?.gamemode})`);
    assert(Object.keys(bot.players).includes("Tester"), "Tester is still online (parked)");
    const busy = await mctp.call("player.act", { sessionId: sid, name: "Carol", verb: "chat", args: { message: "x" } });
    assert(busy.error?.code === -32602 && /controlled/.test(busy.error.message ?? ""),
      `player.act refuses Carol while she's controlled (got ${JSON.stringify(busy.error ?? busy.result)})`);
    const listed = await carol();
    assert(listed?.online === true, "player.list still shows Carol online");

    await bot.waitForChunksToLoad();
    const before = (await carol()).position;
    bot.setControlState("forward", true);
    await sleep(1500);
    bot.setControlState("forward", false);
    await sleep(500);
    const walked = (await carol()).position;
    assert(flat(before, walked) > 1, `walking on the client moves Carol on the server (${flat(before, walked).toFixed(2)} blocks)`);
    say("hello from the keyboard");
    say("/me waves");
    await waitFor("Carol's chat in the log", () => sawLog(/<Carol> hello from the keyboard/), 5000).catch(() => {});
    assert(sawLog(/<Carol> hello from the keyboard/), "chat typed on the client is Carol's");
    await waitFor("Carol's /me", () => sawLog(/\* Carol waves/), 5000).catch(() => {});
    assert(sawLog(/\* Carol waves/), "commands typed on the client run as Carol");

    // 2. back, typed as non-op Carol.
    const returned = nextRespawn(bot);
    say("/actor back");
    const atHome = await Promise.race([returned, sleep(15000).then(() => null)]);
    if (!assert(atHome != null, "/actor back (as non-op Carol) hands the client back")) throw new Error("no return");
    assert(dist(atHome, home) < 1.5, `Tester is back where it was (${fmt(atHome)} vs ${fmt(home)})`);
    await waitFor("Tester's inventory", () => items(bot) === "stickx1", 5000).catch(() => {});
    assert(items(bot) === "stickx1", `Tester has its own inventory (got ${items(bot)})`);
    await waitFor("creative again", () => bot.game.gameMode === "creative", 5000).catch(() => {});
    assert(bot.game.gameMode === "creative", `Tester has its own game mode (got ${bot.game.gameMode})`);
    await waitFor("own tab entry back", () => bot.players.Tester?.gamemode === 1, 5000).catch(() => {});
    assert(bot.players.Tester?.gamemode === 1, `…and its own tab entry says creative (got ${bot.players.Tester?.gamemode})`);
    const carolLeft = (await carol()).position;
    assert(flat(carolLeft, walked) < 1.5, "Carol stays where the client left her");
    const drive = await mctp.call("player.act", { sessionId: sid, name: "Carol", verb: "chat", args: { message: "mine again" } });
    assert(drive.result?.ok === true, `Carol is an actor again (${drive.error?.message ?? "ok"})`);

    // 3. view.
    say("/actor Carol view");
    await waitFor("spectator", () => bot.game.gameMode === "spectator", 5000).catch(() => {});
    assert(bot.game.gameMode === "spectator", `view makes Tester a spectator (got ${bot.game.gameMode})`);
    await sleep(1000);
    assert(dist(bot.entity.position, carolLeft) < 3, `the camera is at Carol (${fmt(bot.entity.position)})`);
    say("/actor back");
    await waitFor("creative after view", () => bot.game.gameMode === "creative", 5000).catch(() => {});
    assert(bot.game.gameMode === "creative", "back from view restores the game mode");
    await sleep(1000);
    assert(dist(bot.entity.position, home) < 1.5, `back from view restores the position (${fmt(bot.entity.position)})`);

    // 5. disconnect while controlling.
    const handed2 = nextRespawn(bot);
    say("/actor Carol control");
    await Promise.race([handed2, sleep(15000)]);
    bot.setControlState("forward", true);
    await sleep(1000);
    bot.setControlState("forward", false);
    await sleep(500);
    const leftAt = (await carol()).position;
    bot.quit();
    bot = null;
    const back = await waitFor("Carol respawned as an actor", async () => {
      const c = await carol();
      const ok = await mctp.call("player.act", { sessionId: sid, name: "Carol", verb: "chat", args: { message: "back" } });
      return c?.online && ok.result?.ok ? c : null;
    }, 15000).catch(() => null);
    assert(back != null, "after the client disconnected, Carol is an actor again");
    if (back) assert(flat(back.position, leftAt) < 1.5, `…where the client left her (${fmt(back.position)} vs ${fmt(leftAt)})`);
    bot = await join_(gamePort, "Tester");
    await sleep(1000);
    assert(dist(bot.entity.position, home) < 1.5, `Tester logs in where it was parked (${fmt(bot.entity.position)})`);
    assert(items(bot) === "stickx1", `…with its own inventory (got ${items(bot)})`);
    assert(bot.game.gameMode === "creative", `…and game mode (got ${bot.game.gameMode})`);

    // 6. the parked player kicked while controlling.
    bot.on("messagestr", (m) => told.push(m));
    const handed3 = nextRespawn(bot);
    say("/actor Carol control");
    assert(await Promise.race([handed3.then(() => true), sleep(15000).then(() => false)]),
      "after logging back in, control works again");
    // The server sends the reason and then closes. If the client is still sending (movement), the close can go
    // out as a TCP reset, and on Windows a reset can drop the reason before the client reads it, so the client
    // sometimes sees a reset, not a kick. Which reason the server gave is in its log; the client only has to go.
    const ended = new Promise((res) => {
      bot.once("kicked", (reason) => res(`kicked ${JSON.stringify(reason)}`));
      bot.once("end", (reason) => res(`end ${reason}`));
    });
    const sentAt = log.length;
    await mctp.call("player.act", { sessionId: sid, name: "Rival", verb: "command", args: { command: "kick Tester parked" } });
    const how = await Promise.race([ended, sleep(10000).then(() => null)]);
    const until = Date.now() + 5000;
    const why = () => log.slice(sentAt).find((l) => /lost connection: Your own player \(Tester\) was disconnected/.test(l));
    while (!why() && Date.now() < until) await sleep(100);
    assert(how != null && why() != null, `kicking the parked player disconnects the client (${how}; server: ${why()?.trim()})`);
    bot = null;
    const back2 = await waitFor("Carol after the kick", async () => {
      const ok = await mctp.call("player.act", { sessionId: sid, name: "Carol", verb: "chat", args: { message: "x" } });
      return ok.result?.ok;
    }, 15000).catch(() => false);
    assert(back2, "after the kick, Carol is an actor again");
    // Only after boot: FML logs class-lookup noise while it starts.
    const booted = log.findIndex((l) => /Done \(/.test(l));
    const errors = log.slice(booted).filter((l) => /ERROR|Exception/.test(l));
    assert(errors.length === 0, `no errors in the server log (${errors.slice(0, 5).join(" | ")})`);
    if (failures.length > 0) {
      console.log("  what Tester was told, for triage:");
      console.log(told.map((l) => `    > ${l}`).join("\n"));
      console.log("  the server's side, for triage:");
      console.log(log.slice(booted).filter((l) => /Tester|Carol|Rival|actor|kick|mc-test/i.test(l))
        .map((l) => `    | ${l}`).join("\n"));
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
  try {
    await server.stop();
  } catch { /* best-effort */ }
  try {
    rmSync(instanceDir, { recursive: true, force: true });
  } catch { /* Windows file locks */ }
}

function fmt(p) {
  return p ? `${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}` : "?";
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
  ? "\nALL bench-control E2E assertions passed"
  : `\n${failures.length} FAILURES:\n - ${failures.join("\n - ")}`);
process.exit(failures.length === 0 ? 0 : 1);
