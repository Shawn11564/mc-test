/**
 * Modded-loader server provisioner (F5): boot a **Fabric / Forge / NeoForge / Quilt
 * dedicated server** (no display — GL is only for rendered clients), install the SUT
 * mods + the server-* truth agent into `mods/`, and wait for "Done (" plus the
 * agent's MCTP bind. Mirrors `PaperProvisioner` (same isolation/determinism), but:
 *   - Fabric/Quilt boot a `fabric-server-launch.jar` (`kind: "jar"`);
 *   - Forge/NeoForge run the installer (`--installServer`) then boot via the
 *     generated `@libraries/.../<os>_args.txt` (`kind: "argsFile"`);
 *   - the agent port is passed via the `MCTEST_AGENT_PORT` env var (modded agents
 *     read it there, not from a config file).
 *
 * The pure helpers (URL/coordinate builders, args-file discovery) are exported and
 * unit-tested; the actual install+boot is acceptance-only (needs network + a JDK).
 */
import { mkdirSync, writeFileSync, createWriteStream, existsSync, cpSync, readdirSync, statSync } from "node:fs";
import { join, resolve, basename, relative } from "node:path";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { resolveMojangServerJar } from "./PaperProvisioner.js";
import {
  writeServerProperties,
  writeOps,
  hasWorldData,
  waitForReady,
  stopServer,
  spawnFromLaunch,
  type AgentSpec,
  type AgentEndpoint,
  type ProvisionedServer,
  type LaunchSpec,
} from "./serverCommon.js";

export interface ModSpec {
  path: string;
  as?: string;
}

export type ServerLoaderFamily = "bukkit" | "fabric" | "quilt" | "forge" | "neoforge" | "vanilla";

export interface ModdedProvisionOptions {
  loader: string;
  mc: string;
  /** Loader version: Fabric loader (else newest stable for `mc`); REQUIRED for Forge/NeoForge. */
  loaderVersion?: string;
  /** Pinned Fabric installer version (else newest stable). */
  fabricInstallerVersion?: string;
  /** A pre-resolved Fabric `fabric-server-launch.jar` (path/url+sha256), bypassing the meta API. */
  serverJar?: string;
  /** A pre-resolved Forge/NeoForge installer jar, bypassing the maven coordinate. */
  installerJar?: string;
  bindHost: string;
  gamePort: number;
  instanceDir: string;
  cacheDir: string;
  /** SUT mods + deps (e.g. fabric-api) to drop into `mods/`. */
  mods: ModSpec[];
  /** Server agents to install into `mods/` + wire to a second MCTP port (via MCTEST_AGENT_PORT). */
  agents?: AgentSpec[];
  worldSnapshotPath?: string;
  levelName?: string;
  serverProps?: Record<string, string | number | boolean>;
  ops?: string[];
  eulaAccepted: boolean;
  javaPath?: string;
  bootTimeoutMs?: number;
  onLog?: (line: string) => void;
  /** Mod ids whose boot-log load to verify (F5; informational unless they gate the report). */
  expectModIds?: string[];
}

const FABRIC_META = "https://meta.fabricmc.net/v2";
const FORGE_MAVEN = "https://maven.minecraftforge.net";
const NEOFORGE_MAVEN = "https://maven.neoforged.net/releases";
const USER_AGENT = "mc-test/0.1 (+https://mc-test.dev; minecraft test framework)";

/** Map any loader to its server family (paper/spigot/folia → bukkit). */
export function loaderFamily(loader: string): ServerLoaderFamily {
  switch (loader.toLowerCase()) {
    case "paper":
    case "spigot":
    case "folia":
      return "bukkit";
    case "fabric":
      return "fabric";
    case "quilt":
      return "quilt";
    case "forge":
      return "forge";
    case "neoforge":
      return "neoforge";
    default:
      return "vanilla";
  }
}

/** The Fabric meta server-launcher download URL (a self-installing `java -jar` server). */
export function fabricServerLauncherUrl(mc: string, loaderVersion: string, installerVersion: string): string {
  return `${FABRIC_META}/versions/loader/${mc}/${loaderVersion}/${installerVersion}/server/jar`;
}

/** The Forge/NeoForge installer maven URL + filename for a `(loader, mc, loaderVersion)`. */
export function loaderInstallerMaven(
  loader: "forge" | "neoforge",
  mc: string,
  loaderVersion: string,
): { url: string; filename: string } {
  if (loader === "forge") {
    const v = `${mc}-${loaderVersion}`; // e.g. 1.20.1-47.3.39
    const filename = `forge-${v}-installer.jar`;
    return { url: `${FORGE_MAVEN}/net/minecraftforge/forge/${v}/${filename}`, filename };
  }
  const filename = `neoforge-${loaderVersion}-installer.jar`; // e.g. neoforge-21.1.66-installer.jar
  return { url: `${NEOFORGE_MAVEN}/net/neoforged/neoforge/${loaderVersion}/${filename}`, filename };
}

interface FabricMetaEntry {
  version: string;
  stable: boolean;
}

/** Resolve the newest stable entry from a Fabric meta list (loader or installer). */
async function newestStable(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
  if (!res.ok) throw new Error(`ARTIFACT_NOT_AVAILABLE: fabric meta ${url} (HTTP ${res.status})`);
  const list = (await res.json()) as FabricMetaEntry[];
  const stable = list.find((e) => e.stable) ?? list[0];
  if (!stable) throw new Error(`ARTIFACT_NOT_AVAILABLE: fabric meta ${url} returned no versions`);
  return stable.version;
}

/** Download a URL to `dest` (unverified — integrity is the HTTPS maven/meta coordinate). */
async function downloadTo(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status} for ${url}`);
  await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(dest));
}

/** Resolve a Fabric/Quilt `fabric-server-launch.jar` (cached) from the meta API. */
async function resolveFabricServerJar(opts: ModdedProvisionOptions): Promise<string> {
  if (opts.serverJar) return opts.serverJar;
  const loaderVersion = opts.loaderVersion ?? (await newestStable(`${FABRIC_META}/versions/loader/${opts.mc}`));
  const installerVersion = opts.fabricInstallerVersion ?? (await newestStable(`${FABRIC_META}/versions/installer`));
  mkdirSync(opts.cacheDir, { recursive: true });
  const dest = join(opts.cacheDir, `fabric-server-${opts.mc}-${loaderVersion}-${installerVersion}.jar`);
  if (!existsSync(dest)) {
    await downloadTo(fabricServerLauncherUrl(opts.mc, loaderVersion, installerVersion), dest);
  }
  return dest;
}

/** Resolve a Forge/NeoForge installer jar (cached) from maven. */
async function resolveLoaderInstaller(opts: ModdedProvisionOptions, loader: "forge" | "neoforge"): Promise<string> {
  if (opts.installerJar) return opts.installerJar;
  if (!opts.loaderVersion) {
    throw new Error(`UNSUPPORTED_TARGET: ${loader} requires loaderVersion (e.g. forge 47.3.39, neoforge 21.1.66)`);
  }
  const { url, filename } = loaderInstallerMaven(loader, opts.mc, opts.loaderVersion);
  mkdirSync(opts.cacheDir, { recursive: true });
  const dest = join(opts.cacheDir, filename);
  if (!existsSync(dest)) await downloadTo(url, dest);
  return dest;
}

/** Run a forge/neoforge installer (`--installServer <dir>`) and await completion. */
async function runInstaller(java: string, installerJar: string, instanceDir: string, onLog?: (l: string) => void): Promise<void> {
  await new Promise<void>((res, rej) => {
    const proc = spawn(java, ["-jar", installerJar, "--installServer", instanceDir], {
      cwd: instanceDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    proc.stdout?.on("data", (d) => onLog?.(d.toString()));
    proc.stderr?.on("data", (d) => onLog?.(d.toString()));
    proc.once("error", rej);
    proc.once("exit", (code) =>
      code === 0 ? res() : rej(new Error(`loader installer exited ${code ?? "?"} (${basename(installerJar)})`)),
    );
  });
}

/**
 * Find the generated `@args` file under `<instanceDir>/libraries` (Forge/NeoForge),
 * returned RELATIVE to instanceDir (with a leading `@` and forward slashes) so it is
 * launched as `java … @libraries/.../<os>_args.txt nogui` from cwd=instanceDir.
 * PURE given a populated tree (unit-tested with a temp dir).
 */
export function findArgsFile(instanceDir: string, platform: NodeJS.Platform = process.platform): string {
  const name = platform === "win32" ? "win_args.txt" : "unix_args.txt";
  const root = join(instanceDir, "libraries");
  const found = findFileNamed(root, name);
  if (!found) {
    throw new Error(`UNSUPPORTED_TARGET: loader installer produced no ${name} under ${root}`);
  }
  return `@${relative(instanceDir, found).split("\\").join("/")}`;
}

/** Depth-first search for a file with the exact basename `name`. */
function findFileNamed(dir: string, name: string): string | undefined {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return undefined;
  }
  for (const e of entries) {
    const p = join(dir, e);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      const hit = findFileNamed(p, name);
      if (hit) return hit;
    } else if (e === name) {
      return p;
    }
  }
  return undefined;
}

/**
 * Provision + boot a modded (Fabric/Forge/NeoForge/Quilt/vanilla) dedicated server.
 * Resolves when the server is ready (and, for an `expectModIds` target, with the
 * boot-log mod-load detection attached).
 */
export async function provisionModded(opts: ModdedProvisionOptions): Promise<ProvisionedServer> {
  if (!opts.eulaAccepted) {
    throw new Error("EULA_NOT_ACCEPTED: set provision.eulaAccepted: true to boot a server");
  }
  const fam = loaderFamily(opts.loader);

  mkdirSync(opts.instanceDir, { recursive: true });
  mkdirSync(join(opts.instanceDir, "logs"), { recursive: true });
  mkdirSync(join(opts.instanceDir, "mods"), { recursive: true });
  writeFileSync(join(opts.instanceDir, "eula.txt"), "eula=true\n");
  writeServerProperties({
    instanceDir: opts.instanceDir,
    gamePort: opts.gamePort,
    bindHost: opts.bindHost,
    ...(opts.levelName ? { levelName: opts.levelName } : {}),
    ...(opts.serverProps ? { serverProps: opts.serverProps } : {}),
  });
  if (opts.ops?.length) writeOps(opts.instanceDir, opts.ops);

  // World (vanilla layout: dimensions nest under the level dir — copying the
  // snapshot to <instance>/<level> is correct for both an empty and a populated snapshot).
  const level = opts.levelName ?? "world";
  if (opts.worldSnapshotPath && existsSync(opts.worldSnapshotPath) && hasWorldData(opts.worldSnapshotPath)) {
    cpSync(opts.worldSnapshotPath, join(opts.instanceDir, level), { recursive: true });
  }

  // SUT mods + deps → mods/.
  for (const mod of opts.mods) {
    const src = resolve(mod.path);
    if (!existsSync(src)) throw new Error(`mod not found: ${src} (build/resolve the SUT mod first)`);
    cpSync(src, join(opts.instanceDir, "mods", mod.as ?? basename(src)));
  }
  // Server agent(s) → mods/ (the modded agent reads MCTEST_AGENT_PORT from the env).
  const agents = opts.agents ?? [];
  for (const agent of agents) {
    const src = resolve(agent.jarPath);
    if (!existsSync(src)) throw new Error(`agent jar not found: ${src} (build agent '${agent.name}' first)`);
    cpSync(src, join(opts.instanceDir, "mods", basename(src)));
  }

  // Resolve the server + build a loader-agnostic launch spec.
  const java = opts.javaPath ?? "java";
  let launch: LaunchSpec;
  if (fam === "fabric" || fam === "quilt") {
    const jar = await resolveFabricServerJar(opts);
    launch = { kind: "jar", java, jvmArgs: ["-Xms1G", "-Xmx2G"], jar, programArgs: ["nogui"], cwd: opts.instanceDir };
  } else if (fam === "forge" || fam === "neoforge") {
    const installer = await resolveLoaderInstaller(opts, fam);
    await runInstaller(java, installer, opts.instanceDir, opts.onLog);
    const argsFile = findArgsFile(opts.instanceDir);
    launch = { kind: "argsFile", java, jvmArgs: ["-Xms1G", "-Xmx2G"], programArgs: [argsFile, "nogui"], cwd: opts.instanceDir };
  } else {
    // vanilla (no mods loader): boot the Mojang server jar directly.
    const jar = await resolveMojangServerJar(opts.mc, opts.cacheDir);
    launch = { kind: "jar", java, jvmArgs: ["-Xms1G", "-Xmx2G"], jar, programArgs: ["nogui"], cwd: opts.instanceDir };
  }
  // The (single) modded agent's MCTP port travels via the env var it reads on init.
  const agentPort = agents[0]?.port;
  if (agentPort !== undefined) launch = { ...launch, env: { MCTEST_AGENT_PORT: String(agentPort) } };

  const logPath = join(opts.instanceDir, "logs", "server.log");
  const logStream = createWriteStream(logPath);
  const proc = spawnFromLaunch(launch);

  let modLoad;
  try {
    const ready = await waitForReady(
      proc,
      logStream,
      opts.onLog,
      // Modded first boot downloads libraries (Fabric) / is already installed (Forge/NeoForge);
      // give it a generous default, overridable via target.timeoutSec.
      opts.bootTimeoutMs ?? 300000,
      agents.map((a) => a.port),
      { loader: fam, ...(opts.expectModIds ? { expectModIds: opts.expectModIds } : {}) },
    );
    modLoad = ready.modLoad;
  } catch (err) {
    await stopServer(proc).catch(() => {});
    throw err;
  }

  const agentEndpoints: AgentEndpoint[] = agents.map((agent) => ({
    name: agent.name,
    url: `ws://${opts.bindHost}:${agent.port}/mctp`,
  }));

  return {
    host: opts.bindHost,
    port: opts.gamePort,
    logPath,
    instanceDir: opts.instanceDir,
    agentEndpoints,
    ...(modLoad ? { modLoad } : {}),
    stop: async () => {
      await stopServer(proc);
      await new Promise<void>((res) => logStream.end(() => res()));
    },
  };
}
