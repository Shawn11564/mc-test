#!/usr/bin/env node
/**
 * Code-coverage spike (feature-map plan, CC spec/40): can JaCoCo tell which mc-test check ran which line of a mod,
 * on each loader? Boots a real 1.21.1 server per lane with a real SUT mod and the JaCoCo agent on the server JVM
 * (`output=tcpserver`, plus `classdumpdir`: a copy of every class exactly as JaCoCo instrumented it). Drives two
 * checks over MCTP as a fake player, dumping + resetting the coverage after boot and after each check, so each check
 * gets its own .exec. Then reports every .exec against the classes from the jar that was deployed:
 *
 *   1. JaCoCo instrumented the SUT under the loader's class loading (the boot dump covers the SUT's entry class);
 *   2. the deployed jar's classes are what JaCoCo instrumented (no "does not match" warning), so line numbers hold;
 *   3. attribution: each check covers its own marker lines and NOT the other check's (the negative control);
 *   4. the loader-rewrite hazard: classes the loader rewrites before JaCoCo sees them (Fabric strips @Environment
 *      members from mod classes; mixins edit their targets) can't match their jar, so their coverage vanishes. The
 *      report is run again against `classdumpdir`; that copy must match for every class (the remedy);
 *   5. IntelliJ (Run › Show Coverage Data runs JaCoCo's Analyzer over the module's compiled classes, so only bytes
 *      that ran show): `jacoco/RekeyExec.java` writes `intellij.exec` keyed to the IDE's classes, which must
 *      match every one of them, cover exactly the lines the class dump covers, and leave only stripped methods
 *      behind (they read not run).
 *
 * Lanes:
 *   neoforge      SUT = MapFactions (--sut, default ../MapFactions): `raid start` vs founding a bank + faction.
 *   fabric        SUT = mc-test's own server-fabric agent (a remapped Fabric mod with a mixin and an access widener;
 *                 the only Fabric server mod with source here), plus Fabric API under JaCoCo: `/macro list` vs
 *                 `/actor list`.
 *   fabric-strip  SUT = tests/fixtures/fabric-env-strip (`./gradlew build` there): `Shared` has a client-only
 *                 method Fabric strips on a server, `Plain` has none. `/covfix plain` vs `/covfix shared`.
 *
 * Leaves the .exec files, XML/CSV and an HTML report under .mc-test/coverage-spike/<lane>-<stamp>/. A lane whose SUT
 * or agent jar is missing is an honest skip. The JaCoCo agent goes in through JAVA_TOOL_OPTIONS (no provisioner
 * option yet).
 *
 *   node tests/e2e/run-coverage.mjs [neoforge|fabric|fabric-strip] [--sut ../MapFactions]   (default: every lane)
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import WebSocket from "ws";
import { provisionModded } from "../../packages/runner/dist/provision/ModdedProvisioner.js";
import { findFreePort } from "../../packages/runner/dist/provision/serverCommon.js";
import { resolveJavaForMc } from "../../packages/runner/dist/provision/jdk.js";
import { resolveModrinth } from "../../packages/runner/dist/provision/modrinth.js";
import { resolveArtifact } from "../../packages/runner/dist/provision/sources.js";

const run = promisify(execFile);

const JACOCO = {
  agent: {
    url: "https://repo1.maven.org/maven2/org/jacoco/org.jacoco.agent/0.8.12/org.jacoco.agent-0.8.12-runtime.jar",
    sha256: "115e8e6e6593ca3a9892dfef695df4d487c706e59e71e64dc0ab95716ee02622",
  },
  cli: {
    url: "https://repo1.maven.org/maven2/org/jacoco/org.jacoco.cli/0.8.12/org.jacoco.cli-0.8.12-nodeps.jar",
    sha256: "594c01125b84864a7fc5a9efab19b71b7de36b27346863f6d7cd0cd45400ceb0",
  },
};
const MC = "1.21.1";
/** The env-strip fixture mod (tests/fixtures/fabric-env-strip): `./gradlew build` there first. */
const FIXTURE = resolve("tests/fixtures/fabric-env-strip");
/** Re-keys an .exec to the classes an IDE compiled, for IntelliJ (see the file). */
const REKEY = resolve("tests/e2e/jacoco/RekeyExec.java");

const argSut = process.argv.indexOf("--sut");
const SUT_DIR = resolve(argSut > 0 ? process.argv[argSut + 1] : "../MapFactions");
const wanted = process.argv.slice(2).find((a, i, all) => !a.startsWith("--") && all[i - 1] !== "--sut");

/** The newest built jar in `dir` matching `re`, skipping sources/slim jars. */
function newestJar(dir, re) {
  if (!existsSync(dir)) return undefined;
  return readdirSync(dir).filter((f) => re.test(f) && !/sources|slim/.test(f)).map((f) => join(dir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

const LANES = [
  {
    id: "neoforge",
    agentJar: "agents/server-neoforge/build/libs/agent-server-neoforge-1.21.1.jar",
    sutJar: () => newestJar(join(SUT_DIR, "build/libs"), /^mapfactions-.*\.jar$/),
    sources: join(SUT_DIR, "src/main/java"),
    ideClasses: join(SUT_DIR, "build/classes/java/main"),
    pkg: "dev/mrshawn/mapfactions",
    includes: "dev.mrshawn.mapfactions.*",
    entry: "MapFactions",
    mixins: ["mixin/CartographyTableMenuMixin", "mixin/CraftingMenuMixin", "mixin/NoiseChunkMixin"],
    boot: (o, sutJar) => provisionModded({
      ...o, loader: "neoforge", mc: MC, loaderVersion: "21.1.234", mods: [{ path: sutJar, as: "mapfactions.jar" }],
    }),
    // Check A: a player in no faction tries to start a raid. Check B: found bank Capital, then faction North.
    checks: [
      { name: "check-a", commands: ["mapfactions raid start"] },
      { name: "check-b", commands: ["mapfactions admin bank create Capital", "faction create North Capital"] },
    ],
    markers: {
      "check-a": [["raid/RaidService.java", "mapfactions.raid.error.not_leader_or_head"]],
      "check-b": [["org/OrgService.java", "\"mapfactions.bank.created\""], ["org/OrgService.java", "\"mapfactions.faction.created\""]],
    },
  },
  {
    id: "fabric",
    agentJar: "agents/server-fabric/build/libs/agent-server-fabric-1.21.1.jar",
    sutJar: () => resolve("agents/server-fabric/build/libs/agent-server-fabric-1.21.1.jar"), // the agent IS the SUT
    sources: resolve("agents/server-fabric/src/main/java"),
    ideClasses: resolve("agents/server-fabric/build/classes/java/main"),
    pkg: "io/mctest/agent/serverfabric",
    includes: "io.mctest.agent.serverfabric.*:net.fabricmc.fabric.*",
    entry: "McTestServerMod",
    mixins: ["mappings/mixin/CommandManagerMixin"],
    fabricApi: true,
    boot: async (o, _sutJar, fabricApiJar) => provisionModded({
      ...o, loader: "fabric", mc: MC, loaderVersion: "0.16.5", mods: [{ path: fabricApiJar, as: "fabric-api.jar" }],
    }),
    // Check A: list the macros (one macro file is in MCTEST_MACROS). Check B: list the actors (Alice is one).
    checks: [
      { name: "check-a", commands: ["macro list"] },
      { name: "check-b", commands: ["actor list"] },
    ],
    markers: {
      "check-a": [["mappings/MacroCommands.java", "String needle = filter.toLowerCase(Locale.ROOT);"]],
      "check-b": [["mappings/ActorCommands.java", "\" [session]\""]],
    },
  },
  {
    id: "fabric-strip",
    agentJar: "agents/server-fabric/build/libs/agent-server-fabric-1.21.1.jar",
    sutJar: () => resolve(FIXTURE, "build/libs/fixture-env-strip-1.21.1.jar"),
    sources: resolve(FIXTURE, "src/main/java"),
    ideClasses: resolve(FIXTURE, "build/classes/java/main"),
    // In the IDE's class the stripped method exists; it never ran on the server, so it must read as not run.
    ideNotRun: [["Shared.java", "MinecraftClient.getInstance()"]],
    ideNotCarried: ["clientOnly"],
    pkg: "io/mctest/fixture/envstrip",
    includes: "io.mctest.fixture.envstrip.*",
    entry: "EnvStripMod",
    mixins: [],
    // Shared has a client-only (@Environment(CLIENT)) method that Fabric strips on a dedicated server, so the bytes
    // that run aren't the jar's. Plain has none: the control.
    rewritten: ["Shared"],
    fabricApi: true,
    boot: async (o, sutJar, fabricApiJar) => provisionModded({
      ...o, loader: "fabric", mc: MC, loaderVersion: "0.16.5",
      mods: [{ path: fabricApiJar, as: "fabric-api.jar" }, { path: sutJar, as: "fixture-env-strip.jar" }],
    }),
    checks: [
      { name: "check-a", commands: ["covfix plain"] },
      { name: "check-b", commands: ["covfix shared"] },
    ],
    markers: {
      "check-a": [["Plain.java", "// coverage marker: plain"]],
      "check-b": [["Shared.java", "// coverage marker: shared"]],
    },
  },
];

const failures = [];
let currentLane = "";
function assert(cond, label) {
  console.log(`  ${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures.push(`${currentLane}: ${label}`);
  return cond;
}

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

/** {ci, mi} for one line of one source file in a JaCoCo XML report; null when the line has no code. */
function lineCoverage(xml, pkg, file, nr) {
  const pkgStart = xml.indexOf(`<package name="${pkg}">`);
  if (pkgStart < 0) return null;
  const block = xml.slice(pkgStart, xml.indexOf("</package>", pkgStart));
  const sfStart = block.indexOf(`<sourcefile name="${file}">`);
  if (sfStart < 0) return null;
  const sf = block.slice(sfStart, block.indexOf("</sourcefile>", sfStart));
  const m = sf.match(new RegExp(`<line nr="${nr}" mi="(\\d+)" ci="(\\d+)"`));
  return m ? { mi: Number(m[1]), ci: Number(m[2]) } : null;
}

/** The report's LINE counter for one class, e.g. {missed, covered}. */
function classLines(xml, className) {
  const at = xml.indexOf(`<class name="${className}"`);
  if (at < 0) return null;
  if (xml[xml.indexOf(">", at) - 1] === "/") return { missed: 0, covered: 0 }; // <class …/>: no code, no counters
  const counters = [...xml.slice(at, xml.indexOf("</class>", at))
    .matchAll(/<counter type="LINE" missed="(\d+)" covered="(\d+)"\/>/g)];
  const last = counters.at(-1);
  return last ? { missed: Number(last[1]), covered: Number(last[2]) } : null;
}

const mismatches = (out) => out.split(/\r?\n/).filter((l) => /does not match/i.test(l));

async function runLane(lane) {
  currentLane = lane.id;
  console.log(`\n=== ${lane.id} ${MC} ===`);
  const sutJar = lane.sutJar();
  if (!sutJar || !existsSync(sutJar)) return console.log(`SKIP ${lane.id}: the SUT isn't built (${sutJar ?? "no jar"})`);
  if (!existsSync(lane.agentJar)) return console.log(`SKIP ${lane.id}: ${lane.agentJar} isn't built`);
  if (!existsSync(lane.sources)) return console.log(`SKIP ${lane.id}: no sources at ${lane.sources}`);

  const cacheDir = resolve(".mc-test/cache");
  const agentJar = await resolveArtifact(JACOCO.agent, join(cacheDir, "jacoco"));
  const cliJar = await resolveArtifact(JACOCO.cli, join(cacheDir, "jacoco"));
  const javaPath = await resolveJavaForMc(MC, { cacheDir });
  const fabricApiJar = lane.fabricApi
    ? await resolveModrinth({ project: "fabric-api", loader: "fabric", gameVersion: MC }, cacheDir)
    : undefined;
  const outDir = resolve(".mc-test/coverage-spike", `${lane.id}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  const classDump = join(outDir, "classdump");
  const instanceDir = join(outDir, "server");
  const macroDir = join(outDir, "macros");
  mkdirSync(instanceDir, { recursive: true });
  mkdirSync(macroDir, { recursive: true });
  writeFileSync(join(macroDir, "spike.macro"), "macro hello who\n  # Says hello.\n  /tellraw {who} \"hello\"\nend\n");

  const gamePort = await findFreePort("127.0.0.1", 25800, 25999);
  const agentPort = await findFreePort("127.0.0.1", gamePort + 1, 25999);
  const jacocoPort = await findFreePort("127.0.0.1", 6300, 6399);

  // The server JVM inherits process.env; the JaCoCo CLI runs get an env without the agent, or they'd load it too.
  const cliEnv = { ...process.env };
  delete cliEnv.JAVA_TOOL_OPTIONS;
  const cli = async (...args) => {
    const { stdout, stderr } = await run(javaPath, ["-jar", cliJar, ...args], { env: cliEnv, maxBuffer: 64 << 20 });
    return stdout + stderr;
  };
  const dump = (name) =>
    cli("dump", "--address", "127.0.0.1", "--port", String(jacocoPort), "--destfile", join(outDir, `${name}.exec`), "--reset");

  console.log(`SUT jar: ${sutJar}\nout: ${outDir}`);
  const log = [];
  let server;
  let client;
  try {
    process.env.MCTEST_MACROS = macroDir;
    process.env.JAVA_TOOL_OPTIONS = `-javaagent:${agentJar}=output=tcpserver,address=127.0.0.1,port=${jacocoPort},`
      + `includes=${lane.includes},classdumpdir=${classDump}`;
    server = await lane.boot({
      bindHost: "127.0.0.1", gamePort, instanceDir, cacheDir, javaPath,
      agents: [{ name: `server-${lane.id}`, jarPath: resolve(lane.agentJar), port: agentPort }],
      ops: ["Alice"], eulaAccepted: true, bootTimeoutMs: 300000,
      onLog: (chunk) => log.push(...String(chunk).split(/\r?\n/)),
    }, sutJar, fabricApiJar);
    delete process.env.JAVA_TOOL_OPTIONS;
    assert(log.some((l) => l.includes("Picked up JAVA_TOOL_OPTIONS")), "the server JVM picked up the JaCoCo agent");
    await dump("boot");

    client = await connect(server.agentEndpoints[0]?.url ?? `ws://127.0.0.1:${agentPort}/mctp`);
    const created = await client.call("session.create", {
      protocolVersion: "1.0",
      client: { name: "coverage-spike", version: "0.1.0", lang: "ts" },
      requiredCapabilities: ["fakePlayers"],
    });
    const sid = created.result?.sessionId;
    if (!sid) throw new Error(`session.create failed: ${JSON.stringify(created.error ?? created)}`);
    const spawned = await client.call("player.spawnFake", { sessionId: sid, name: "Alice" });
    if (!spawned.result?.ok) throw new Error(`spawnFake failed: ${JSON.stringify(spawned.error ?? spawned)}`);
    // Join listeners may run on later ticks; give them a moment, then file them under neither check.
    await new Promise((r) => setTimeout(r, 1000));
    await dump("spawn");
    for (const check of lane.checks) {
      for (const command of check.commands) {
        // player.act runs the command on the server thread and answers after it ran, so the dump sees its hits.
        const r = await client.call("player.act", { sessionId: sid, name: "Alice", verb: "command", args: { command } });
        if (!r.result?.ok) throw new Error(`/${command} failed: ${JSON.stringify(r.error ?? r)}`);
      }
      await dump(check.name);
    }
  } finally {
    delete process.env.JAVA_TOOL_OPTIONS;
    delete process.env.MCTEST_MACROS;
    client?.close();
    await server?.stop().catch(() => {});
  }

  // The SUT's classes as deployed (not build/classes), extracted from its jar with the JDK's jar tool.
  const classesDir = join(outDir, "classes");
  mkdirSync(classesDir, { recursive: true });
  const props = await run(javaPath, ["-XshowSettings:properties", "-version"], { env: cliEnv });
  const javaHome = (props.stdout + props.stderr).match(/^\s*java\.home = (.+)$/m)?.[1]?.trim();
  await run(join(javaHome, "bin", process.platform === "win32" ? "jar.exe" : "jar"), ["xf", sutJar, lane.pkg],
    { cwd: classesDir, env: cliEnv });
  const names = ["boot", "spawn", ...lane.checks.map((c) => c.name)];
  await cli("merge", ...names.map((n) => join(outDir, `${n}.exec`)), "--destfile", join(outDir, "all.exec"));
  const report = async (name, classfiles, tag) => {
    const out = await cli("report", join(outDir, `${name}.exec`), ...classfiles.flatMap((c) => ["--classfiles", c]),
      "--sourcefiles", lane.sources, "--xml", join(outDir, `${tag}.xml`));
    return { out, xml: readFileSync(join(outDir, `${tag}.xml`), "utf8") };
  };
  // Two readings of the same .exec: against the jar as deployed, and against classdumpdir (the bytes JaCoCo saw).
  const vsJar = {};
  const reports = {};
  for (const n of [...names, "all"]) {
    vsJar[n] = await report(n, [classesDir], `${n}-vs-jar`);
    reports[n] = await report(n, [classDump], n);
  }
  await cli("report", join(outDir, "all.exec"), "--classfiles", classDump, "--sourcefiles", lane.sources,
    "--html", join(outDir, "html"));

  console.log("--- the loader-rewrite hazard ---");
  const dumped = existsSync(classDump) ? readdirSync(classDump, { recursive: true }).filter((f) => String(f).endsWith(".class")).length : 0;
  assert(dumped > 0, `classdumpdir holds the instrumented classes (${dumped})`);
  const rewritten = [...new Set(Object.values(vsJar).flatMap((r) => mismatches(r.out))
    .map((l) => l.match(/class (\S+) /)?.[1]).filter(Boolean))].sort();
  const expected = (lane.rewritten ?? []).map((c) => `${lane.pkg}/${c}`).sort();
  assert(rewritten.join() === expected.join(), expected.length
    ? `against the jar, exactly the rewritten SUT classes don't match: ${rewritten.join(", ") || "none"}`
    : `against the jar, every SUT class matches (the loader ran the jar's bytes)${rewritten.length ? `: ${rewritten.join(", ")}` : ""}`);
  const dumpMis = Object.values(reports).flatMap((r) => mismatches(r.out));
  assert(dumpMis.length === 0, `against classdumpdir, every class matches (${dumpMis.length} mismatches)`);
  if (fabricApiJar && lane.includes.includes("net.fabricmc")) {
    const api = await report("all", [fabricApiJar], "fabric-api-vs-jar");
    const apiMis = mismatches(api.out);
    console.log(`  Fabric API against its jar: ${apiMis.length} class(es) don't match`);
    for (const l of apiMis.slice(0, 4)) console.log(`    ${l.trim()}`);
  }

  console.log("--- instrumentation ---");
  const entry = classLines(reports.boot.xml, `${lane.pkg}/${lane.entry}`);
  assert(entry != null && entry.covered > 0, `boot covers the SUT's entry class ${lane.entry} (${entry ? `${entry.covered} lines` : "absent"})`);

  console.log("--- attribution, per check (against classdumpdir) ---");
  const marks = Object.entries(lane.markers).flatMap(([owner, list]) => list.map(([file, needle]) => {
    const lines = readFileSync(join(lane.sources, lane.pkg, file), "utf8").split(/\r?\n/);
    const nr = lines.findIndex((l) => l.includes(needle)) + 1;
    if (nr === 0) throw new Error(`${needle} not found in ${file}`);
    const slash = file.lastIndexOf("/");
    return { owner, file, nr, pkg: `${lane.pkg}${slash < 0 ? "" : `/${file.slice(0, slash)}`}`, base: file.slice(slash + 1),
      cls: `${lane.pkg}/${file.replace(/\.java$/, "")}` };
  }));
  const at = (r, m) => lineCoverage(r.xml, m.pkg, m.base, m.nr);
  const shown = (c) => (c ? `ci=${c.ci} mi=${c.mi}` : "no code");
  for (const check of lane.checks) {
    for (const m of marks) {
      const c = at(reports[check.name], m);
      if (m.owner === check.name) assert(c?.ci > 0, `${check.name} covers ${m.base}:${m.nr} [${shown(c)}]`);
      else assert(c != null && c.ci === 0, `${check.name} does NOT cover ${m.base}:${m.nr} [${shown(c)}]`);
    }
  }
  for (const m of marks.filter((mk) => rewritten.includes(mk.cls))) {
    const jarSide = at(vsJar[m.owner], m);
    assert(!(jarSide?.ci > 0), `against the jar, ${m.base}:${m.nr} reads NOT covered [${shown(jarSide)}]: the false red classdumpdir fixes`);
  }

  console.log("--- IntelliJ (Run > Show Coverage Data) ---");
  // IntelliJ runs JaCoCo's Analyzer over the module's compiled classes, so a class only shows coverage when those
  // bytes are the ones that ran. Re-keying carries the hits onto the IDE's classes method by method.
  if (!lane.ideClasses || !existsSync(lane.ideClasses)) {
    console.log(`  skipped: no IDE classes at ${lane.ideClasses}`);
  } else {
    const raw = await report("all", [lane.ideClasses], "all-vs-ide");
    console.log(`  as recorded, ${mismatches(raw.out).length} of the IDE's classes don't match what ran`);
    const ideExec = join(outDir, "intellij.exec");
    const rk = await run(javaPath, ["-cp", cliJar, REKEY, join(outDir, "all.exec"), classDump, lane.ideClasses, ideExec],
      { env: cliEnv });
    for (const l of rk.stdout.trim().split(/\r?\n/)) console.log(`  ${l.trim()}`);
    const ide = await cli("report", ideExec, "--classfiles", lane.ideClasses, "--sourcefiles", lane.sources,
      "--xml", join(outDir, "intellij.xml"));
    const ideXml = readFileSync(join(outDir, "intellij.xml"), "utf8");
    assert(mismatches(ide).length === 0, `the re-keyed .exec matches every IDE class (${mismatches(ide).length} mismatches)`);
    const notCarried = rk.stdout.split(/\r?\n/).flatMap((l) => l.match(/so not run: (.+)$/)?.[1].split(", ") ?? []);
    const wantNotCarried = lane.ideNotCarried ?? [];
    assert([...new Set(notCarried)].sort().join() === [...wantNotCarried].sort().join(),
      `only the stripped methods are left behind (${notCarried.join(", ") || "none"})`);
    // Nothing that ran may go missing: per SUT class, the IDE view covers exactly the lines the class dump covers.
    const lost = [...reports.all.xml.matchAll(/<class name="([^"]+)"/g)].map((m) => m[1])
      .filter((cls) => cls.startsWith(`${lane.pkg}/`))
      .map((cls) => ({ cls, dump: classLines(reports.all.xml, cls)?.covered ?? 0, ide: classLines(ideXml, cls)?.covered ?? 0 }))
      .filter((c) => c.dump !== c.ide);
    assert(lost.length === 0, `every SUT class covers the same lines in the IDE as in the class dump${lost.length ? `: ${lost.slice(0, 4).map((c) => `${c.cls} ${c.dump}→${c.ide}`).join(", ")}` : ""}`);
    for (const m of marks) {
      const c = at({ xml: ideXml }, m);
      assert(c?.ci > 0, `in the IDE's classes, ${m.base}:${m.nr} reads covered [${shown(c)}]`);
    }
    for (const [file, needle] of lane.ideNotRun ?? []) {
      const nr = readFileSync(join(lane.sources, lane.pkg, file), "utf8").split(/\r?\n/).findIndex((l) => l.includes(needle)) + 1;
      const c = lineCoverage(ideXml, lane.pkg, file, nr);
      assert(c != null && c.ci === 0 && c.mi > 0, `in the IDE's classes, the stripped ${file}:${nr} reads not run [${shown(c)}]`);
    }
    console.log(`  open in IntelliJ: ${ideExec}`);
  }

  console.log("--- information ---");
  const total = vsJar.all.xml.match(/<counter type="LINE" missed="(\d+)" covered="(\d+)"\/>\s*<counter type="COMPLEXITY"[^>]*\/>\s*<counter type="METHOD"[^>]*\/>\s*<counter type="CLASS"[^>]*\/>\s*<\/report>/);
  if (total) console.log(`  whole run: ${total[2]} of ${Number(total[1]) + Number(total[2])} SUT lines executed`);
  for (const mixin of lane.mixins) {
    const c = classLines(vsJar.all.xml, `${lane.pkg}/${mixin}`);
    console.log(`  mixin ${mixin}: ${c ? `${c.covered}/${c.missed + c.covered} lines` : "not in report"}`);
  }
  console.log(`  report: ${join(outDir, "html", "index.html")}`);
}

async function main() {
  for (const lane of LANES.filter((l) => !wanted || l.id === wanted)) await runLane(lane);
  if (failures.length) {
    console.log(`\nFAILED (${failures.length}): ${failures.join("; ")}`);
    process.exit(1);
  }
  console.log("\nCoverage spike PASSED");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
