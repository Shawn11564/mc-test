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
import { existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import type { Capabilities } from "@mc-test/protocol";
import { loadMatrix, findTarget, resolveWorld } from "./config/loadMatrix.js";
import { loadSteps } from "./config/loadSteps.js";
import { Runner, type ProvisionHandle, type TargetMeta, type AgentConn } from "./engine/Runner.js";
import { needsDeferredViaBridge, HEADLESS_NATIVE_MC_RANGE } from "./engine/viaPreflight.js";
import { defaultRegistry, type DriverLaunchContext } from "./drivers/DriverRegistry.js";
import { provisionPaper, findFreePort, type AgentSpec } from "./provision/PaperProvisioner.js";
import { resolveArtifact } from "./provision/sources.js";
import { resolveJavaForMc } from "./provision/jdk.js";
import { resolveSpigotJar } from "./provision/buildtools.js";
import { writeJUnit } from "./report/JUnitReporter.js";
import { writeHtml } from "./report/HtmlReporter.js";
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
    // Resolve + integrity-check each plugin source (path, or url+sha256) to a local jar.
    const resolvedPlugins: { path: string; as?: string }[] = [];
    for (const p of target.plugins ?? []) {
      resolvedPlugins.push({ path: await resolveArtifact(p, cacheDir), ...(p.as ? { as: p.as } : {}) });
    }
    // Multi-JDK: legacy MC needs an older Java than the host (e.g. 1.8.x needs Java 8, not 21).
    // Map mc → an acceptable Java major and resolve a matching JDK — the host if it fits (modern
    // targets boot unchanged with no download), else a configured/installed one, else a Temurin
    // build fetched from Adoptium into the cache. Resolved FIRST so a Spigot build can reuse it.
    const javaPath = await resolveJavaForMc(target.mc, {
      cacheDir,
      ...(prov.jdks ? { configured: prov.jdks } : {}),
      ...(prov.downloadJdks !== undefined ? { download: prov.downloadJdks } : {}),
      onLog: (line) => console.log(`  ${line}`),
    });
    // Server jar source. The PaperMC fill API can't serve 1.8.x, so a plugin-capable old server
    // comes from either an explicit `server: { path | url, sha256 }` jar OR `server: { spigot: {
    // version } }` — built from source with Spigot BuildTools under `javaPath` (the same JDK the
    // server boots with, e.g. Java 8). Absent these, the default Paper-API path (`server.paper.build`)
    // is used. Booted directly via `serverJar`, bypassing the fill API.
    const serverSrc = target.server;
    let serverJar: string | undefined;
    if (serverSrc && (serverSrc.path || serverSrc.url)) {
      serverJar = await resolveArtifact(serverSrc, cacheDir);
    } else if (serverSrc?.spigot) {
      serverJar = await resolveSpigotJar(serverSrc.spigot.version ?? target.mc, {
        cacheDir,
        javaPath,
        onLog: (line) => console.log(`  ${line}`),
      });
    }
    const server = await provisionPaper({
      mc: target.mc,
      build: target.server?.paper?.build ?? "latest",
      ...(serverJar ? { serverJar } : {}),
      javaPath,
      bindHost,
      gamePort,
      instanceDir,
      cacheDir,
      plugins: resolvedPlugins,
      ...(agentSpecs.length ? { agents: agentSpecs } : {}),
      ...(worldSnapshotPath ? { worldSnapshotPath } : {}),
      ...(world?.levelName ? { levelName: world.levelName } : {}),
      ...(target.serverProps ? { serverProps: target.serverProps } : {}),
      ...(target.ops ? { ops: target.ops } : {}),
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

/**
 * Honest preflight (F2, native old-version support). The headless bot speaks its advertised
 * `mcVersionRange` NATIVELY (Mineflayer + minecraft-data), so an in-range target — including
 * old versions like 1.8.9 — connects DIRECTLY; `via` is advisory and needs no proxy. We only
 * honest-skip here when a `via: true` target's `mc` is OUTSIDE the native range: that genuinely
 * needs ViaProxy protocol bridging, a deferred v2 follow-on, so emit a precise reason
 * (`VIA_BRIDGE_UNAVAILABLE`) instead of a dubious pass. An out-of-range target WITHOUT `via` is
 * skipped by capability negotiation (`NO_COMPATIBLE_DRIVER`, unmet `mcVersionRange`). Returns a
 * skipped `TestResult`, or undefined to run.
 */
function preflightSkip(test: ReturnType<typeof loadSteps>, target: MatrixTarget): TestResult | undefined {
  if (needsDeferredViaBridge(target)) {
    const message =
      `via:true target '${target.id}' (mc ${target.mc}) skipped: its version is outside the headless ` +
      `bot's native range (${HEADLESS_NATIVE_MC_RANGE}), so it needs ViaProxy protocol bridging — a ` +
      `deferred v2 follow-on. In-range versions (incl. legacy like 1.8.9) connect directly with no proxy; ` +
      `pair them with a plugin-capable 'server: { url|path, sha256 }'. Skipping with a precise reason ` +
      `rather than a dubious pass — see docs/ENVIRONMENTS.md (version spanning).`;
    return {
      name: test.name,
      target: target.id,
      ...(target.loader ? { loader: target.loader } : {}),
      ...(target.mc ? { mc: target.mc } : {}),
      outcome: "skipped",
      durationMs: 0,
      steps: [],
      skip: { category: "environment", reason: "VIA_BRIDGE_UNAVAILABLE", unmet: [], message },
      systemOut: message,
    };
  }
  return undefined;
}

/** Run one target and print its per-test result. */
async function runOneTarget(
  runner: Runner,
  matrix: MatrixFile,
  target: MatrixTarget,
  test: ReturnType<typeof loadSteps>,
  outDir: string,
): Promise<TestResult> {
  const pre = preflightSkip(test, target);
  if (pre) {
    console.log(`Running '${test.name}' against target '${target.id}' (${target.loader} ${target.mc}, via)…`);
    printResult(pre);
    return pre;
  }
  console.log(`Running '${test.name}' against target '${target.id}' (${target.loader} ${target.mc})…`);
  // `outDir` lets the screenshot verb persist PNGs + seed/diff baselines under it.
  const result = await runner.runTarget(test, targetMetaFor(target), buildProvision(matrix, target), "Tester", outDir);
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
      results.push(await runOneTarget(runner, matrix, target, test, outDir));
    }
  }

  // One aggregated JUnit (one <testsuite> per target) + a human HTML report + artifacts.
  const junitPath = join(outDir, "junit", "results.xml");
  writeJUnit(junitPath, results);
  const htmlPath = join(outDir, "report.html");
  writeHtml(htmlPath, results);
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
  console.log(`HTML:  ${htmlPath}`);
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

const INIT_MATRIX = `# mc-test.yml — environment matrix.
# Run: npx mc-test run src/mctest/example.mctest.yml --target paper-1.20.4
version: 1
provision:
  eulaAccepted: true   # you accept Mojang's EULA by setting this (required to boot a server)
  bindHost: 127.0.0.1  # loopback only
targets:
  - id: paper-1.20.4
    loader: paper
    mc: "1.20.4"
    driver: headless
    server: { paper: { build: latest } }
    plugins:
      - { path: ./build/libs/your-plugin.jar }   # <-- point at your built plugin jar (or use the Gradle plugin)
    agents: [server-bukkit]                        # server-truth: assertPluginState / fixtures
`;

const INIT_TEST = `# yaml-language-server: $schema=https://mc-test.dev/schema/mctest-stepfile.schema.json
name: example
requires:
  command: true
  containerGui: true
steps:
  - join: { username: Tester }
  - command: "your-command"          # e.g. the command that opens your plugin's GUI
  - waitForScreen: { titleContains: "Your GUI Title" }
  - click: { label: "Some Button" }
  - assertChat: { contains: "expected message" }
  # Prove it from real server state (requires agents: [server-bukkit]):
  # - assertPluginState: { plugin: "YourPlugin", query: "your.query", args: {}, expect: true }
`;

/** Write a file only if absent; report which happened (never overwrites user files). */
function scaffold(path: string, content: string, label: string): string {
  if (existsSync(path)) return `exists   ${label}`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
  return `created  ${label}`;
}

/** `mc-test init` — scaffold a matrix + a sample step file in `--dir` (default cwd). */
function cmdInit(args: Args): number {
  const dir = resolve(args.flags["dir"] ?? ".");
  console.log("mc-test init:");
  console.log(`  ${scaffold(join(dir, "mc-test.yml"), INIT_MATRIX, "mc-test.yml")}`);
  console.log(
    `  ${scaffold(join(dir, "src", "mctest", "example.mctest.yml"), INIT_TEST, "src/mctest/example.mctest.yml")}`,
  );
  console.log("\nNext:");
  console.log("  1. Edit mc-test.yml → point plugins[].path at your built plugin jar.");
  console.log("  2. Edit src/mctest/example.mctest.yml → your command/GUI/assertions.");
  console.log("  3. npx mc-test doctor   # check Java, ports, downloads");
  console.log("  4. npx mc-test run src/mctest/example.mctest.yml --target paper-1.20.4");
  console.log("\nSee docs/GETTING_STARTED.md and docs/AUTHORING.md.");
  return 0;
}

/** `mc-test doctor` — environment + config readiness checks. */
async function cmdDoctor(args: Args): Promise<number> {
  console.log("mc-test doctor:");
  let hardFail = false;
  const line = (ok: boolean | "warn", label: string, detail = ""): void => {
    const mark = ok === true ? "✓" : ok === "warn" ? "!" : "✗";
    console.log(`  ${mark} ${label}${detail ? `: ${detail}` : ""}`);
    if (ok === false) hardFail = true;
  };

  line(true, "node", process.version);

  const java = await checkCommand("java", ["-version"]);
  line(java, "java", java ? "present" : "MISSING — needed to boot a server");

  let net = false;
  try {
    net = (await fetch("https://fill.papermc.io/v3/projects/paper")).ok;
  } catch {
    net = false;
  }
  line(net ? true : "warn", "PaperMC fill API", net ? "reachable" : "unreachable (offline? server jars can't download)");

  try {
    const p = await findFreePort("127.0.0.1", 25700, 25899);
    line(true, "ports", `free port available (e.g. ${p})`);
  } catch {
    line("warn", "ports", "no free port in 25700–25899");
  }

  const matrixPath = resolve(args.flags["matrix"] ?? "mc-test.yml");
  if (existsSync(matrixPath)) {
    try {
      const matrix = loadMatrix(matrixPath);
      line(true, "matrix", `${matrixPath} (${matrix.targets.length} target(s))`);
    } catch (err) {
      line(false, "matrix", `${matrixPath} — parse error: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    line("warn", "matrix", `${matrixPath} not found (run \`mc-test init\`)`);
  }

  const agentJar = resolve(REPO_ROOT, KNOWN_AGENTS["server-bukkit"]!.jarPath);
  line(
    existsSync(agentJar) ? true : "warn",
    "server-bukkit agent jar",
    existsSync(agentJar) ? "built" : "not built (assertPluginState/fixtures will skip)",
  );

  return hardFail ? 1 : 0;
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

/** Top-level usage, printed on `--help`/`-h`/`help`/no-command and on an unknown command. */
const USAGE = `mc-test — automated testing for Minecraft plugins & mods

usage: mc-test <command> [options]

commands:
  run <stepfile.mctest.yml> [more...]   run test(s) against the matrix
        [--target <id>|<id,id,...>|all] [--matrix mc-test.yml]
        [--plugin built-sut.jar] [--out dir] [--fail-on-skip]
  list                                  list targets in the matrix [--matrix mc-test.yml]
  doctor                                check Java, ports, downloads, matrix [--matrix mc-test.yml]
  init                                  scaffold mc-test.yml + a sample test [--dir <dir>]

docs: docs/GETTING_STARTED.md · docs/AUTHORING.md`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];

  // Help is a first-class request, not an error: `--help` (a parsed flag), `-h` or
  // `help` (a positional), or no command at all prints usage to STDOUT and exits 0.
  // `mc-test --help` must be a clean success — it is the CI smoke test and a stated
  // v1.0 acceptance gate. (A genuinely unknown command still errors to stderr, below.)
  if (
    args.flags["help"] === "true" ||
    command === undefined ||
    command === "-h" ||
    command === "help"
  ) {
    console.log(USAGE);
    process.exit(0);
  }

  let code: number;
  try {
    switch (command) {
      case "run":
        code = await cmdRun(args);
        break;
      case "list":
        code = cmdList(args);
        break;
      case "init":
        code = cmdInit(args);
        break;
      case "doctor":
        code = await cmdDoctor(args);
        break;
      default:
        console.error(`mc-test: unknown command '${command}'\n`);
        console.error(USAGE);
        code = 2;
    }
  } catch (err) {
    // loadSteps/loadMatrix/provision embed helpful messages (file path, parse error);
    // surface them as one line rather than dumping a raw Node stack trace at the user.
    console.error(`mc-test: ${err instanceof Error ? err.message : String(err)}`);
    code = 2;
  }
  process.exit(code);
}

void main();
