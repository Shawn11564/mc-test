#!/usr/bin/env node
/**
 * `mc-test` CLI — `run`, `list`, `doctor`.
 *
 *   mc-test run <stepfile.mctest.yml> [more.mctest.yml ...] [--target <id>|all]
 *           [--matrix mc-test.yml] [--plugin built-sut.jar] [--out dir]
 *   mc-test list   [--matrix mc-test.yml]
 *   mc-test doctor [--matrix mc-test.yml]
 *
 * `--plugin` overrides each target's SUT jar with a build-graph artifact (used by
 * the Gradle front door so the freshly-built jar is tested without editing the
 * matrix). Multiple step files run as (test × target), aggregated into one JUnit.
 */
import { resolve, join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { existsSync, rmSync } from "node:fs";
import type { Capabilities } from "@mc-test/protocol";
import { loadMatrix, findTarget, resolveWorld } from "./config/loadMatrix.js";
import { loadSteps } from "./config/loadSteps.js";
import { Runner, type ProvisionHandle, type TargetMeta, type AgentConn } from "./engine/Runner.js";
import { defaultRegistry, type DriverLaunchContext } from "./drivers/DriverRegistry.js";
import { provisionPaper, findFreePort, type AgentSpec } from "./provision/PaperProvisioner.js";
import { writeJUnit } from "./report/JUnitReporter.js";
import { renderSkipMatrix } from "./report/SkipMatrix.js";
import { collectArtifacts } from "./report/Artifacts.js";
import type { MatrixFile, MatrixTarget } from "./model/Target.js";
import type { TestResult } from "./model/result.js";

/**
 * The capabilities the Bukkit server agent advertises (PROTOCOL.md §6.3:
 * serverPlugin → `worldTruth, pluginState, fixtures, fakePlayers, chat,
 * testIdTags`). Used to build the `AgentConn` the runner co-selects.
 */
const SERVER_BUKKIT_CAPABILITIES: Capabilities = {
  worldTruth: true,
  pluginState: true,
  fixtures: true,
  fakePlayers: true,
  chat: true,
  testIdTags: true,
  loader: ["paper", "spigot", "folia"],
};

/**
 * The capabilities the Fabric server-mod agent advertises (M5): the same
 * server-truth surface as the Bukkit agent (PROTOCOL.md §6.3: serverMod →
 * `worldTruth, pluginState, fixtures, fakePlayers, chat, testIdTags`), but for
 * the Fabric/NeoForge/Quilt **server** loaders. Used to build the `AgentConn` the
 * runner co-selects alongside a rendered-client (`inprocess`) driver.
 */
const SERVER_FABRIC_CAPABILITIES: Capabilities = {
  worldTruth: true,
  pluginState: true,
  fixtures: true,
  fakePlayers: true,
  chat: true,
  testIdTags: true,
  loader: ["fabric", "neoforge", "quilt"],
};

/**
 * Monorepo root, derived from the runner's own location (…/packages/runner/dist/
 * cli.js → up 3). Built-in agent jar paths resolve from here so the runner finds
 * them regardless of the caller's CWD — e.g. when the Gradle front door invokes it
 * from a SUT project directory rather than the monorepo root.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Known server agents: how to find their built jar (ROADMAP §4 / DRIVERS.md). */
const KNOWN_AGENTS: Record<string, { jarPath: string; advertised: Capabilities }> = {
  "server-bukkit": {
    jarPath: "agents/server-bukkit/build/libs/mc-test-agent-bukkit.jar",
    advertised: SERVER_BUKKIT_CAPABILITIES,
  },
  // M5: the Fabric/NeoForge server-mod truth agent (Loom build — acceptance-only
  // in this repo's CI; build-artifact `agent-server-fabric-<mc>.jar`).
  "server-fabric": {
    jarPath: "agents/server-fabric/build/libs/agent-server-fabric.jar",
    advertised: SERVER_FABRIC_CAPABILITIES,
  },
};

/**
 * Known **client** agents (M4 + M5): the in-game mod jar the in-process driver
 * injects into the rendered client. Built externally (Loom / ForgeGradle /
 * NeoGradle) — acceptance-only in this repo's CI (build-artifact
 * `agent-client-<loader>-<mc>.jar`, ENVIRONMENTS.md). The client agent is paired
 * implicitly by `driver: inprocess`; the loader is selected by which `client-*`
 * agent the target lists (default `client-fabric`).
 */
const KNOWN_CLIENT_AGENTS: Record<string, { jarPath: string }> = {
  "client-fabric": {
    jarPath: "agents/client-fabric/build/libs/agent-client-fabric.jar",
  },
  // M5 fan-out: Forge (MCP-SRG mappings) and NeoForge (Mojmap mappings) client shims.
  "client-forge": {
    jarPath: "agents/client-forge/build/libs/agent-client-forge.jar",
  },
  "client-neoforge": {
    jarPath: "agents/client-neoforge/build/libs/agent-client-neoforge.jar",
  },
};

interface Args {
  _: string[];
  flags: Record<string, string>;
}

function parseArgs(argv: string[]): Args {
  const _: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "true";
      }
    } else {
      _.push(a);
    }
  }
  return { _, flags };
}

function expandHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

function pluginSpecs(target: MatrixTarget): { path: string; as?: string }[] {
  return (target.plugins ?? [])
    .filter((p) => p.path)
    .map((p) => ({ path: resolve(p.path!), ...(p.as ? { as: p.as } : {}) }));
}

/** Resolve the configured **server** agents into install specs (M3). Client
 *  agents (M4) are launched by the in-process driver, not the provisioner, so
 *  they are skipped here. Unknown agent names throw with a clear message; a
 *  missing built jar is reported at boot. */
function resolveAgentJars(target: MatrixTarget): { name: string; jarPath: string; advertised: Capabilities }[] {
  return (target.agents ?? [])
    .filter((name) => !(name in KNOWN_CLIENT_AGENTS))
    .map((name) => {
      const known = KNOWN_AGENTS[name];
      if (!known) {
        const known2 = [...Object.keys(KNOWN_AGENTS), ...Object.keys(KNOWN_CLIENT_AGENTS)].join(", ");
        throw new Error(`unknown agent '${name}' (target '${target.id}'); known: ${known2}`);
      }
      const override = target.agentSources?.[name]?.path;
      return {
        name,
        // A user-supplied override is CWD-relative; the built-in path is monorepo-relative.
        jarPath: override ? resolve(override) : resolve(REPO_ROOT, known.jarPath),
        advertised: known.advertised,
      };
    });
}

/**
 * Resolve the client-agent jar the in-process driver injects into the rendered
 * client (M4). Prefers a `client-*` agent named in `target.agents` (honoring a
 * `target.agentSources` path override); defaults to `client-fabric` for an
 * inprocess target. Returns an absolute jar path — built externally
 * (acceptance-only); a missing jar is reported when the driver launches.
 */
function resolveClientAgentJar(target: MatrixTarget): string {
  const named = (target.agents ?? []).find((name) => name in KNOWN_CLIENT_AGENTS) ?? "client-fabric";
  const known = KNOWN_CLIENT_AGENTS[named]!;
  const override = target.agentSources?.[named]?.path;
  return override ? resolve(override) : resolve(REPO_ROOT, known.jarPath);
}

/**
 * Build the in-process driver's launch context from an `inprocess` target (M4):
 * which MC/loader, the display backend, the SUT mod jars to inject, and the
 * client-agent jar. The Paper provisioner still boots the SERVER the client
 * connects to; the rendered client itself is launched by the driver via this
 * context. (For M4's no-boot CI this path is wired but not exercised.)
 */
function buildLaunchContext(target: MatrixTarget): DriverLaunchContext {
  const mods = (target.mods ?? [])
    .filter((m) => m.path)
    .map((m) => resolve(m.path!));
  return {
    ...(target.mc ? { mc: target.mc } : {}),
    ...(target.loader ? { loader: target.loader } : {}),
    ...(target.display ? { display: target.display } : {}),
    ...(mods.length ? { mods } : {}),
    clientAgentJar: resolveClientAgentJar(target),
  };
}

function buildProvision(
  matrix: MatrixFile,
  target: MatrixTarget,
): () => Promise<ProvisionHandle> {
  const prov = matrix.provision ?? {};
  const bindHost = prov.bindHost ?? "127.0.0.1";
  const [from, to] = prov.portRange ?? [25700, 25899];
  const cacheDir = expandHome(prov.cacheDir ?? "~/.mc-test/cache");
  const workDir = prov.workDir ?? ".mc-test/run";
  // Retain the per-instance work dir on failure (default true) for log/artifact
  // triage; on success it is deleted so .mc-test/run/ does not grow unbounded.
  const keepOnFailure = prov.keepOnFailure ?? true;
  const world = resolveWorld(matrix, target);
  const worldSnapshotPath = world?.snapshot?.path ? resolve(world.snapshot.path) : undefined;
  const agentJars = resolveAgentJars(target);

  return async () => {
    const gamePort = await findFreePort(bindHost, from, to);
    // Each agent gets its own MCTP port, distinct from the game port and each other.
    const agentSpecs: AgentSpec[] = [];
    let portCursor = gamePort + 1;
    for (const agent of agentJars) {
      const agentPort = await findFreePort(bindHost, portCursor, to);
      agentSpecs.push({ name: agent.name, jarPath: agent.jarPath, port: agentPort });
      portCursor = agentPort + 1;
    }
    const instanceDir = resolve(join(workDir, `${target.id}-${gamePort}-${process.pid}`));
    const server = await provisionPaper({
      mc: target.mc,
      build: target.server?.paper?.build ?? "latest",
      bindHost,
      gamePort,
      instanceDir,
      cacheDir,
      plugins: pluginSpecs(target),
      ...(agentSpecs.length ? { agents: agentSpecs } : {}),
      ...(worldSnapshotPath ? { worldSnapshotPath } : {}),
      ...(world?.levelName ? { levelName: world.levelName } : {}),
      ...(target.serverProps ? { serverProps: target.serverProps } : {}),
      eulaAccepted: prov.eulaAccepted ?? false,
      onLog: () => {},
    });
    // Pair each resolved endpoint with the agent's advertised caps → AgentConn.
    const agentConns: AgentConn[] = server.agentEndpoints.map((ep) => {
      const known = agentJars.find((a) => a.name === ep.name);
      return { url: ep.url, advertised: known?.advertised ?? SERVER_BUKKIT_CAPABILITIES, kind: "serverPlugin" };
    });
    return {
      host: server.host,
      port: server.port,
      logPath: server.logPath,
      ...(agentConns.length ? { agents: agentConns } : {}),
      stop: server.stop,
      cleanup: async (failed: boolean) => {
        if (failed && keepOnFailure) return; // retain failed instance dir for triage
        // Best-effort: on Linux/CI (where disk growth actually matters) the dir is
        // removed promptly. On Windows, Paper's world region files + session.lock are
        // released slowly after JVM exit, so the dir may persist until a later run —
        // a dev-only annoyance, not a CI concern. retryDelay rides out the transient.
        try {
          rmSync(server.instanceDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
        } catch {
          /* a still-held handle simply leaves the dir behind */
        }
      },
    };
  };
}

function printResult(result: TestResult): void {
  const icon = result.outcome === "passed" ? "✓" : result.outcome === "skipped" ? "○" : "✗";
  console.log(`\n${icon} ${result.name} [${result.target}] — ${result.outcome.toUpperCase()} (${(result.durationMs / 1000).toFixed(1)}s, driver=${result.driver ?? "none"})`);
  for (const note of result.notes ?? []) console.log(`  ${note}`);
  for (const s of result.steps) {
    const si = s.outcome === "passed" ? "  ✓" : s.outcome === "skipped" ? "  ○" : "  ✗";
    if (s.outcome === "skipped" && s.skip) {
      console.log(`${si} ${s.verb}: SKIPPED ${s.skip.reason} unmet=[${s.skip.unmet.join(",")}]`);
    } else if (s.outcome === "failed") {
      console.log(`${si} ${s.verb}: FAILED ${s.error?.reason ?? ""} ${s.error?.message ?? ""}`);
    } else {
      console.log(`${si} ${s.verb}${s.detail ? `: ${s.detail}` : ""}`);
    }
  }
  if (result.skip) console.log(`  → skipped: ${result.skip.message}`);
  if (result.failure) console.log(`  → failure: ${result.failure.message}`);
}

/** Build the `TargetMeta` for one matrix row (driver pin + inprocess launch ctx). */
function targetMetaFor(target: MatrixTarget): TargetMeta {
  // An `inprocess` target launches a rendered client: thread a launch context
  // (mc/loader/display, SUT mods, client-agent jar) to the driver. The server is
  // still provisioned (M3 wiring intact) for the client to connect to and for any
  // co-listed server agent (pluginState).
  return {
    target: target.id,
    loader: target.loader,
    mc: target.mc,
    ...(target.driver && target.driver !== "auto" ? { driverPin: target.driver } : {}),
    ...(target.driver === "inprocess" ? { launch: buildLaunchContext(target) } : {}),
  };
}

/** Run one target and print its per-test result. */
async function runOneTarget(
  runner: Runner,
  matrix: MatrixFile,
  target: MatrixTarget,
  test: ReturnType<typeof loadSteps>,
): Promise<TestResult> {
  console.log(`Running '${test.name}' against target '${target.id}' (${target.loader} ${target.mc}${target.via ? ", via ViaProxy" : ""})…`);
  const result = await runner.runTarget(test, targetMetaFor(target), buildProvision(matrix, target));
  printResult(result);
  return result;
}

async function cmdRun(args: Args): Promise<number> {
  const stepFiles = args._.slice(1);
  if (stepFiles.length === 0) {
    console.error(
      "usage: mc-test run <stepfile.mctest.yml> [more.mctest.yml ...] [--target <id>|all] [--matrix mc-test.yml] [--plugin built-sut.jar] [--out dir]",
    );
    return 2;
  }
  const matrixPath = resolve(args.flags["matrix"] ?? "mc-test.yml");
  if (!existsSync(matrixPath)) {
    console.error(`matrix file not found: ${matrixPath} (pass --matrix)`);
    return 2;
  }
  const matrix = loadMatrix(matrixPath);

  // Target selection: a single `--target <id>`, or the WHOLE matrix when
  // `--target all` / `--all` is given (ROADMAP §6.3 — author once, run across the
  // matrix, aggregate into one JUnit + a skip matrix).
  const targetSel = args.flags["target"];
  const runAll = args.flags["all"] === "true" || targetSel === "all" || targetSel === undefined;
  let targets: MatrixTarget[];
  if (runAll) {
    targets = matrix.targets;
    if (targetSel === undefined) {
      console.log(`No --target given → running the whole matrix (${targets.length} targets). Pass --target <id[,id...]> for a subset.`);
    }
  } else {
    // Accept a single id or a comma-separated subset (the Gradle front door passes
    // its configured `targets` this way).
    const ids = targetSel!.split(",").map((s) => s.trim()).filter(Boolean);
    targets = [];
    for (const id of ids) {
      const target = findTarget(matrix, id);
      if (!target) {
        console.error(`target '${id}' not found in ${matrixPath}`);
        return 2;
      }
      targets.push(target);
    }
  }

  // --plugin <jar>: override each target's SUT plugin with a build-graph artifact
  // (the Gradle front door passes the freshly-built jar so it is tested without
  // hand-editing mc-test.yml). Replaces the target's `plugins` with the one jar.
  const pluginOverride = args.flags["plugin"] ? resolve(args.flags["plugin"]) : undefined;
  if (pluginOverride) {
    if (!existsSync(pluginOverride)) {
      console.error(`--plugin jar not found: ${pluginOverride} (build the SUT first)`);
      return 2;
    }
    targets = targets.map((t) => ({ ...t, plugins: [{ path: pluginOverride }] }));
  }

  const tests = stepFiles.map((f) => loadSteps(resolve(f)));
  const outDir = resolve(args.flags["out"] ?? "mc-test-report");
  const runner = new Runner(defaultRegistry());

  // Per-target isolation (distinct leased ports + per-instance world copies, see
  // PaperProvisioner) makes the targets independent; we run them sequentially for
  // deterministic, readable output. Each `buildProvision` is a fresh closure, so a
  // future bounded-concurrency pool is a drop-in. Multiple step files run as
  // (target × test) and aggregate into one JUnit.
  const results: TestResult[] = [];
  for (const target of targets) {
    for (const test of tests) {
      results.push(await runOneTarget(runner, matrix, target, test));
    }
  }

  // One aggregated JUnit (one <testsuite> per target) + per-result artifacts.
  const junitPath = join(outDir, "junit", "results.xml");
  writeJUnit(junitPath, results);
  let artifactCount = 0;
  for (const result of results) {
    const bundle = collectArtifacts(outDir, result);
    artifactCount += bundle.files.length;
  }

  // The cross-target skip matrix: which (test × target) cells were skipped and why.
  if (results.length > 1) {
    console.log(`\n${renderSkipMatrix(results)}`);
  }
  console.log(`\nJUnit: ${junitPath}`);
  if (artifactCount) console.log(`Artifacts: ${join(outDir, "artifacts")}`);

  const failOnSkip = args.flags["fail-on-skip"] === "true";
  if (results.some((r) => r.outcome === "failed")) return 1;
  if (failOnSkip && results.some((r) => r.outcome === "skipped")) return 1;
  return 0;
}

function cmdList(args: Args): number {
  const matrixPath = resolve(args.flags["matrix"] ?? "mc-test.yml");
  if (!existsSync(matrixPath)) {
    console.error(`matrix file not found: ${matrixPath}`);
    return 2;
  }
  const matrix = loadMatrix(matrixPath);
  console.log(`Targets in ${matrixPath}:`);
  for (const t of matrix.targets) {
    console.log(`  - ${t.id}  (loader=${t.loader} mc=${t.mc} driver=${t.driver ?? "auto"})`);
  }
  return 0;
}

async function cmdDoctor(args: Args): Promise<number> {
  console.log("mc-test doctor:");
  const java = await checkCommand("java", ["-version"]);
  console.log(`  java: ${java ? "ok" : "MISSING (needed to boot a server)"}`);
  let net = false;
  try {
    const res = await fetch("https://fill.papermc.io/v3/projects/paper");
    net = res.ok;
  } catch {
    net = false;
  }
  console.log(`  PaperMC API reachable: ${net ? "ok" : "no"}`);
  const matrixPath = resolve(args.flags["matrix"] ?? "mc-test.yml");
  console.log(`  matrix file (${matrixPath}): ${existsSync(matrixPath) ? "found" : "not found"}`);
  return java ? 0 : 1;
}

function checkCommand(cmd: string, cmdArgs: string[]): Promise<boolean> {
  return new Promise((resolveCheck) => {
    import("node:child_process").then(({ spawn }) => {
      const p = spawn(cmd, cmdArgs, { stdio: "ignore" });
      p.once("error", () => resolveCheck(false));
      p.once("exit", (code) => resolveCheck(code === 0));
    });
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  let code: number;
  switch (command) {
    case "run":
      code = await cmdRun(args);
      break;
    case "list":
      code = cmdList(args);
      break;
    case "doctor":
      code = await cmdDoctor(args);
      break;
    default:
      console.error("usage: mc-test <run|list|doctor> [...]");
      code = 2;
  }
  process.exit(code);
}

void main();
