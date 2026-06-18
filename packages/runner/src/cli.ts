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
import { runMatrix, resolveConcurrency } from "./engine/runMatrix.js";
import { needsDeferredViaBridge, HEADLESS_NATIVE_MC_RANGE } from "./engine/viaPreflight.js";
import { defaultRegistry, type DriverLaunchContext } from "./drivers/DriverRegistry.js";
import { findFreePort, type AgentSpec, type ModLoad } from "./provision/serverCommon.js";
import { provisionServer } from "./provision/provisionServer.js";
import { loaderFamily, type ModSpec } from "./provision/ModdedProvisioner.js";
import { resolveArtifact } from "./provision/sources.js";
import { resolveJavaForMc, resolveJdk, requiredJavaMajor, javaMajorOf } from "./provision/jdk.js";
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
  loader: ["fabric", "quilt"],
};

/**
 * The Forge / NeoForge server-mod truth agents (F5). Same server-truth surface as the
 * Fabric agent, but for a FORGE / NEOFORGE server. `fakePlayers` is NOT advertised —
 * those loaders have no Carpet-style fake-player backend by default, so those steps
 * honestly skip (the agent's live grant is authoritative regardless). Scaffolded /
 * acceptance-only like the client forge/neoforge shims (ForgeGradle / NeoGradle build).
 */
const SERVER_FORGE_CAPABILITIES: Capabilities = {
  worldTruth: true,
  pluginState: true,
  fixtures: true,
  chat: true,
  testIdTags: true,
  loader: ["forge"],
};

const SERVER_NEOFORGE_CAPABILITIES: Capabilities = {
  worldTruth: true,
  pluginState: true,
  fixtures: true,
  chat: true,
  testIdTags: true,
  loader: ["neoforge"],
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
  // M5: the Fabric server-mod truth agent (Loom build — acceptance-only in this
  // repo's CI; build-artifact `agent-server-fabric.jar`).
  "server-fabric": {
    jarPath: "agents/server-fabric/build/libs/agent-server-fabric.jar",
    advertised: SERVER_FABRIC_CAPABILITIES,
  },
  // F5: the Forge/NeoForge server-mod truth agents (ForgeGradle/NeoGradle build —
  // acceptance-only; build-artifacts `agent-server-{forge,neoforge}.jar`). A modded
  // forge/neoforge SERVER row co-selects one of these; absent its built jar the
  // server-truth steps honestly skip (the cost-1 `server` driver needs an agent).
  "server-forge": {
    jarPath: "agents/server-forge/build/libs/agent-server-forge.jar",
    advertised: SERVER_FORGE_CAPABILITIES,
  },
  "server-neoforge": {
    jarPath: "agents/server-neoforge/build/libs/agent-server-neoforge.jar",
    advertised: SERVER_NEOFORGE_CAPABILITIES,
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

/** Short flag aliases (`-j 4` ≡ `--concurrency 4`). */
const SHORT_FLAGS: Record<string, string> = { "-j": "concurrency", "-c": "concurrency" };

function parseArgs(argv: string[]): Args {
  const _: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    // A flag's value never itself starts with `-` in this CLI (targets, paths,
    // dirs, numbers don't), so a following `-`/`--` token is the NEXT flag, not a
    // value — this lets `--all -j 4` parse `all=true` rather than eating `-j`.
    const takesValue = (next: string | undefined): next is string =>
      next !== undefined && !next.startsWith("-");
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (takesValue(next)) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "true";
      }
    } else if (SHORT_FLAGS[a]) {
      const key = SHORT_FLAGS[a];
      const next = argv[i + 1];
      if (takesValue(next)) {
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
function buildLaunchContext(target: MatrixTarget, clientJavaPath?: string): DriverLaunchContext {
  const mods = (target.mods ?? [])
    .filter((m) => m.path)
    .map((m) => resolve(m.path!));
  return {
    ...(target.mc ? { mc: target.mc } : {}),
    ...(target.loader ? { loader: target.loader } : {}),
    ...(target.loaderVersion ? { loaderVersion: target.loaderVersion } : {}),
    ...(target.display ? { display: target.display } : {}),
    ...(mods.length ? { mods } : {}),
    ...(clientJavaPath ? { javaPath: clientJavaPath } : {}),
    clientAgentJar: resolveClientAgentJar(target),
  };
}

/**
 * Resolve the `java` to launch a RENDERED client with. Unlike the server (which runs fine on a newer
 * host JDK), the client is pinned to its MC version's LWJGL build: MC ≤1.20.x ships LWJGL 3.3.1, which
 * SIGSEGVs on Java 21 ("Unsupported JNI version detected"), so a Forge 1.20.1 client MUST run on Java 17
 * while a 1.21.1 client wants Java 21. We therefore pick the EXACT LTS for the MC version
 * (`requiredJavaMajor`): reuse the host `java` when it already matches, else resolve/fetch that JDK.
 */
async function resolveClientJava(
  mc: string | undefined,
  prov: NonNullable<MatrixFile["provision"]>,
): Promise<string | undefined> {
  if (!mc) return undefined;
  const want = requiredJavaMajor(mc);
  if (javaMajorOf("java") === want) return "java";
  return resolveJdk(want, {
    cacheDir: expandHome(prov.cacheDir ?? "~/.mc-test/cache"),
    ...(prov.jdks ? { configured: prov.jdks } : {}),
    ...(prov.downloadJdks !== undefined ? { download: prov.downloadJdks } : {}),
    onLog: (line) => console.log(`  ${line}`),
  });
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
      // A co-selected agent whose built jar is absent (e.g. the acceptance-only
      // server-forge/neoforge shims not built in this lane) is DROPPED, not a hard
      // error — its capability-gated steps then honestly skip, and a `driver: server`
      // target with no agent left skips NO_SERVER_AGENT (never a false green).
      if (!existsSync(agent.jarPath)) {
        console.warn(`  ⚠ agent '${agent.name}' jar not built (${agent.jarPath}) — dropped; its steps will skip`);
        continue;
      }
      const agentPort = await findFreePort(bindHost, portCursor, to);
      agentSpecs.push({ name: agent.name, jarPath: agent.jarPath, port: agentPort });
      portCursor = agentPort + 1;
    }
    const instanceDir = resolve(join(workDir, `${target.id}-${gamePort}-${process.pid}`));
    // Server family: a target with `server: { paper }` is Bukkit even if its `loader`
    // names a mod loader (the rendered-client rows host a Paper server + the regions
    // PLUGIN, and put the client mod elsewhere). Otherwise the loader decides — a
    // fabric/forge/neoforge target with no Paper server is a MODDED SERVER (F5).
    const serverIsBukkit = !!target.server?.paper || loaderFamily(target.loader) === "bukkit";
    // Bukkit → SUT plugins into plugins/; modded → SUT mods (incl. modrinth deps) into mods/.
    const resolvedPlugins: { path: string; as?: string }[] = [];
    const resolvedMods: ModSpec[] = [];
    if (serverIsBukkit) {
      for (const p of target.plugins ?? []) {
        resolvedPlugins.push({ path: await resolveArtifact(p, cacheDir), ...(p.as ? { as: p.as } : {}) });
      }
    } else {
      for (const m of target.mods ?? []) {
        resolvedMods.push({ path: await resolveArtifact(m, cacheDir), ...(m.as ? { as: m.as } : {}) });
      }
    }
    // Multi-JDK: legacy MC needs an older Java than the host (e.g. 1.8.x needs Java 8, not 21);
    // Forge 1.20.1 needs Java 17. Map mc → an acceptable Java major and resolve a matching JDK —
    // the host if it fits, else a configured/installed one, else a fetched Temurin. Resolved FIRST
    // so a Spigot build / loader installer reuses it.
    const javaPath = await resolveJavaForMc(target.mc, {
      cacheDir,
      ...(prov.jdks ? { configured: prov.jdks } : {}),
      ...(prov.downloadJdks !== undefined ? { download: prov.downloadJdks } : {}),
      onLog: (line) => console.log(`  ${line}`),
    });
    // Server jar / loader installer source.
    //  - Bukkit: explicit `server: { path|url, sha256 }` jar, or `server: { spigot }` (BuildTools),
    //    else the Paper-API path. Booted directly via `serverJar`.
    //  - Modded fabric: an explicit `server: { url|path, sha256 }` fabric-server-launch.jar
    //    (else the provisioner resolves it from the Fabric meta API by loaderVersion).
    //  - Modded forge/neoforge: a `loaderInstaller: { url|path }` installer override (else the
    //    provisioner resolves the installer from maven by loaderVersion).
    const serverSrc = target.server;
    let serverJar: string | undefined;
    let installerJar: string | undefined;
    if (serverSrc && (serverSrc.path || serverSrc.url)) {
      serverJar = await resolveArtifact(serverSrc, cacheDir);
    } else if (serverIsBukkit && serverSrc?.spigot) {
      serverJar = await resolveSpigotJar(serverSrc.spigot.version ?? target.mc, {
        cacheDir,
        javaPath,
        onLog: (line) => console.log(`  ${line}`),
      });
    }
    if (!serverIsBukkit && target.loaderInstaller && (target.loaderInstaller.path || target.loaderInstaller.url)) {
      installerJar = await resolveArtifact(target.loaderInstaller, cacheDir);
    }
    const server = await provisionServer({
      loader: target.loader,
      mc: target.mc,
      ...(target.loaderVersion ? { loaderVersion: target.loaderVersion } : {}),
      build: target.server?.paper?.build ?? "latest",
      ...(serverJar ? { serverJar } : {}),
      ...(installerJar ? { installerJar } : {}),
      javaPath,
      bindHost,
      gamePort,
      instanceDir,
      cacheDir,
      plugins: resolvedPlugins,
      mods: resolvedMods,
      ...(agentSpecs.length ? { agents: agentSpecs } : {}),
      ...(worldSnapshotPath ? { worldSnapshotPath } : {}),
      ...(world?.levelName ? { levelName: world.levelName } : {}),
      ...(target.serverProps ? { serverProps: target.serverProps } : {}),
      ...(target.ops ? { ops: target.ops } : {}),
      eulaAccepted: prov.eulaAccepted ?? false,
      ...(target.expectMods ? { expectModIds: target.expectMods } : {}),
      onLog: () => {},
    });
    // Boot-log gate (F5): a target that DECLARED `expectMods` fails if the loader did not
    // load one (a hard `MOD_NOT_LOADED`). Without `expectMods` the modLoad signal is purely
    // informational (surfaced on the result). The MCTP `mod.loaded` assertion stays primary.
    if (target.expectMods?.length && server.modLoad && server.modLoad.missing.length) {
      await server.stop().catch(() => {});
      throw new Error(
        `MOD_NOT_LOADED: ${server.modLoad.missing.join(", ")} not found in the ${target.loader} boot log`,
      );
    }
    // Pair each resolved endpoint with the agent's advertised caps → AgentConn.
    const agentKind = serverIsBukkit ? "serverPlugin" : "serverMod";
    const agentConns: AgentConn[] = server.agentEndpoints.map((ep) => {
      const known = agentJars.find((a) => a.name === ep.name);
      return { url: ep.url, advertised: known?.advertised ?? SERVER_BUKKIT_CAPABILITIES, kind: agentKind };
    });
    return {
      host: server.host,
      port: server.port,
      logPath: server.logPath,
      ...(agentConns.length ? { agents: agentConns } : {}),
      ...(server.modLoad ? { modLoad: server.modLoad } : {}),
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
  // Emit the whole per-target block in ONE console.log so it stays contiguous
  // even when targets run concurrently (--concurrency > 1) and finish interleaved.
  const icon = result.outcome === "passed" ? "✓" : result.outcome === "skipped" ? "○" : "✗";
  const lines: string[] = [
    `\n${icon} ${result.name} [${result.target}] — ${result.outcome.toUpperCase()} (${(result.durationMs / 1000).toFixed(1)}s, driver=${result.driver ?? "none"})`,
  ];
  for (const note of result.notes ?? []) lines.push(`  ${note}`);
  for (const s of result.steps) {
    const si = s.outcome === "passed" ? "  ✓" : s.outcome === "skipped" ? "  ○" : "  ✗";
    if (s.outcome === "skipped" && s.skip) {
      lines.push(`${si} ${s.verb}: SKIPPED ${s.skip.reason} unmet=[${s.skip.unmet.join(",")}]`);
    } else if (s.outcome === "failed") {
      lines.push(`${si} ${s.verb}: FAILED ${s.error?.reason ?? ""} ${s.error?.message ?? ""}`);
    } else {
      lines.push(`${si} ${s.verb}${s.detail ? `: ${s.detail}` : ""}`);
    }
  }
  if (result.skip) lines.push(`  → skipped: ${result.skip.message}`);
  if (result.failure) lines.push(`  → failure: ${result.failure.message}`);
  console.log(lines.join("\n"));
}

/** Build the `TargetMeta` for one matrix row (driver pin + inprocess launch ctx). */
function targetMetaFor(target: MatrixTarget, clientJavaPath?: string): TargetMeta {
  // An `inprocess` target launches a rendered client: thread a launch context
  // (mc/loader/display, SUT mods, client-agent jar, the MC-matched client JDK) to
  // the driver. The server is still provisioned (M3 wiring intact) for the client to
  // connect to and for any co-listed server agent (pluginState).
  return {
    target: target.id,
    loader: target.loader,
    mc: target.mc,
    ...(target.driver && target.driver !== "auto" ? { driverPin: target.driver } : {}),
    ...(target.driver === "inprocess" ? { launch: buildLaunchContext(target, clientJavaPath) } : {}),
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
  const renderedLoader = renderedLoaderSkip(target);
  if (renderedLoader) {
    return {
      name: test.name,
      target: target.id,
      ...(target.loader ? { loader: target.loader } : {}),
      ...(target.mc ? { mc: target.mc } : {}),
      outcome: "skipped",
      durationMs: 0,
      steps: [],
      skip: { category: "environment", reason: "UNSUPPORTED_TARGET", unmet: [], message: renderedLoader },
      systemOut: renderedLoader,
    };
  }
  return undefined;
}

/** Loaders whose rendered-client launch needs the loader installer (Forge family). */
const MODULAR_RENDERED_LOADERS = ["forge", "neoforge"];

/**
 * F4 honest skip: a `driver: inprocess` target on a modular loader (forge/neoforge)
 * needs the loader installer to run on a GL-capable host (CI-gated). Unless opted in
 * via `MC_TEST_RENDERED_LOADERS=<loader>`, honest-skip BEFORE provisioning — so we
 * neither boot a server for a client we won't launch nor emit a false RED offline,
 * and never a false green. Fabric/Quilt are fully implemented (F3) and never skip
 * here. Returns the skip message, or undefined to run. (The in-process provisioner
 * is the matching safety net if this is bypassed; both use reason UNSUPPORTED_TARGET.)
 */
function renderedLoaderSkip(target: MatrixTarget): string | undefined {
  const loader = (target.loader ?? "").toLowerCase();
  if (target.driver !== "inprocess" || !MODULAR_RENDERED_LOADERS.includes(loader)) return undefined;
  const optedIn = (process.env["MC_TEST_RENDERED_LOADERS"] ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .includes(loader);
  if (optedIn) return undefined; // run for real on the opted-in capable host
  return (
    `inprocess target '${target.id}' (${loader} ${target.mc}) skipped: the ${loader} rendered-client ` +
    `launch is CI-gated — it needs the ${loader} installer to run on a GL-capable host. Enable on a ` +
    `capable runner with MC_TEST_RENDERED_LOADERS=${loader}. Honest-skip (never a false green) — see docs/DRIVERS.md.`
  );
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
  // A rendered (inprocess) client is pinned to its MC version's JDK (LWJGL compat); resolve it up front
  // so the driver launches the client with the right `java` (headless targets need nothing here).
  const clientJavaPath =
    target.driver === "inprocess" ? await resolveClientJava(target.mc, matrix.provision ?? {}) : undefined;
  // `outDir` lets the screenshot verb persist PNGs + seed/diff baselines under it.
  const result = await runner.runTarget(test, targetMetaFor(target, clientJavaPath), buildProvision(matrix, target), "Tester", outDir);
  printResult(result);
  return result;
}

async function cmdRun(args: Args): Promise<number> {
  const stepFiles = args._.slice(1);
  if (stepFiles.length === 0) {
    console.error(
      "usage: mc-test run <stepfile.mctest.yml> [more.mctest.yml ...] [--target <id>|all] [--matrix mc-test.yml] [--plugin built-sut.jar] [--out dir] [--concurrency N|auto]",
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
  // PaperProvisioner) makes every (target × test) job independent, so the matrix
  // runs through a bounded-concurrency pool (F4 / ROADMAP §6.3). `--concurrency N`
  // (`-j N`, or `auto`) sets the pool size; the default is 1 (sequential) so
  // output streams readably and we don't boot several servers at once unasked.
  // `runMatrix` preserves INPUT order in `results`, so the aggregated JUnit +
  // skip matrix are deterministic regardless of which job finishes first.
  // By default every test runs against every target (cross-product). With `--pair`,
  // stepfiles and targets are zipped 1:1 in the order given — so a heterogeneous
  // suite (e.g. a headless plugin test on `paper`, the client-GUI test on each
  // rendered loader) aggregates into ONE report with exactly N cells and no
  // wrong-driver skips. Requires an equal count of stepfiles and targets.
  const pair = args.flags["pair"] === "true";
  let jobs: { target: MatrixTarget; test: ReturnType<typeof loadSteps> }[];
  if (pair) {
    if (tests.length !== targets.length) {
      console.error(
        `--pair needs an equal number of stepfiles and targets (got ${tests.length} stepfile(s), ${targets.length} target(s)); they are zipped 1:1 in order.`,
      );
      return 2;
    }
    jobs = targets.map((target, i) => ({ target, test: tests[i]! }));
  } else {
    jobs = targets.flatMap((target) => tests.map((test) => ({ target, test })));
  }
  const concurrency = resolveConcurrency(args.flags["concurrency"], jobs.length);
  if (concurrency > 1) {
    console.log(`Running ${jobs.length} (target × test) job(s) with concurrency ${concurrency}.`);
  }
  const results: TestResult[] = await runMatrix(jobs.length, concurrency, (i) => {
    const { target, test } = jobs[i]!;
    return runOneTarget(runner, matrix, target, test, outDir);
  });

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
        [--concurrency N|auto] (-j)     run the (target × test) matrix in parallel
        [--pair]                        zip stepfiles↔targets 1:1 (not cross-product)
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
