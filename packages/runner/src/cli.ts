#!/usr/bin/env node
/**
 * `mc-test` CLI — `run`, `list`, `doctor`.
 *
 *   mc-test run <stepfile.mctest.yml> --target <id> [--matrix mc-test.yml] [--out dir]
 *   mc-test list   [--matrix mc-test.yml]
 *   mc-test doctor [--matrix mc-test.yml]
 */
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import type { Capabilities } from "@mc-test/protocol";
import { loadMatrix, findTarget, resolveWorld } from "./config/loadMatrix.js";
import { loadSteps } from "./config/loadSteps.js";
import { Runner, type ProvisionHandle, type TargetMeta, type AgentConn } from "./engine/Runner.js";
import { defaultRegistry, type DriverLaunchContext } from "./drivers/DriverRegistry.js";
import { provisionPaper, findFreePort, type AgentSpec } from "./provision/PaperProvisioner.js";
import { writeJUnit } from "./report/JUnitReporter.js";
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

/** Known server agents: how to find their built jar (ROADMAP §4 / DRIVERS.md). */
const KNOWN_AGENTS: Record<string, { jarPath: string; advertised: Capabilities }> = {
  "server-bukkit": {
    jarPath: "agents/server-bukkit/build/libs/mc-test-agent-bukkit.jar",
    advertised: SERVER_BUKKIT_CAPABILITIES,
  },
};

/**
 * Known **client** agents (M4): the in-game mod jar the in-process driver injects
 * into the rendered client. Built externally (Fabric Loom) — acceptance-only in
 * this repo's CI (build-artifact `agent-client-fabric-<mc>.jar`, ENVIRONMENTS.md).
 * The client agent is paired implicitly by `driver: inprocess`; for M4 a single
 * known client agent (`client-fabric`) suffices.
 */
const KNOWN_CLIENT_AGENTS: Record<string, { jarPath: string }> = {
  "client-fabric": {
    jarPath: "agents/client-fabric/build/libs/agent-client-fabric.jar",
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
        jarPath: resolve(override ?? known.jarPath),
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
  return resolve(override ?? known.jarPath);
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
    };
  };
}

function printResult(result: TestResult): void {
  const icon = result.outcome === "passed" ? "✓" : result.outcome === "skipped" ? "○" : "✗";
  console.log(`\n${icon} ${result.name} [${result.target}] — ${result.outcome.toUpperCase()} (${(result.durationMs / 1000).toFixed(1)}s, driver=${result.driver ?? "none"})`);
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

async function cmdRun(args: Args): Promise<number> {
  const stepFile = args._[1];
  if (!stepFile) {
    console.error("usage: mc-test run <stepfile.mctest.yml> --target <id>");
    return 2;
  }
  const matrixPath = resolve(args.flags["matrix"] ?? "mc-test.yml");
  if (!existsSync(matrixPath)) {
    console.error(`matrix file not found: ${matrixPath} (pass --matrix)`);
    return 2;
  }
  const matrix = loadMatrix(matrixPath);
  const targetId = args.flags["target"];
  if (!targetId) {
    console.error("missing --target <id>");
    return 2;
  }
  const target = findTarget(matrix, targetId);
  if (!target) {
    console.error(`target '${targetId}' not found in ${matrixPath}`);
    return 2;
  }

  const test = loadSteps(resolve(stepFile));
  const outDir = resolve(args.flags["out"] ?? "mc-test-report");

  // An `inprocess` target launches a rendered client: thread a launch context
  // (mc/loader/display, SUT mods, client-agent jar) to the driver. The server is
  // still provisioned (M3 wiring intact) for the client to connect to and for any
  // co-listed server agent (pluginState).
  const meta: TargetMeta = {
    target: target.id,
    loader: target.loader,
    mc: target.mc,
    ...(target.driver && target.driver !== "auto" ? { driverPin: target.driver } : {}),
    ...(target.driver === "inprocess" ? { launch: buildLaunchContext(target) } : {}),
  };

  console.log(`Running '${test.name}' against target '${target.id}' (${target.loader} ${target.mc})…`);
  const runner = new Runner(defaultRegistry());
  const result = await runner.runTarget(test, meta, buildProvision(matrix, target));

  printResult(result);

  const junitPath = join(outDir, "junit", "results.xml");
  writeJUnit(junitPath, [result]);
  const bundle = collectArtifacts(outDir, result);
  console.log(`\nJUnit: ${junitPath}`);
  if (bundle.files.length) console.log(`Artifacts: ${bundle.dir}`);

  const failOnSkip = args.flags["fail-on-skip"] === "true";
  if (result.outcome === "failed") return 1;
  if (result.outcome === "skipped" && failOnSkip) return 1;
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
