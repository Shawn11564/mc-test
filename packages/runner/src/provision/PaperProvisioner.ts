/**
 * Bukkit-family provisioner: download a Paper jar (PaperMC fill API), write an
 * offline `server.properties` + `eula.txt`, copy the world snapshot (Bukkit
 * sibling-dimension layout), drop the SUT plugin(s) + server agent into
 * `plugins/`, boot the server, wait for "Done (", and expose a teardown hook.
 *
 * Shared boot primitives (ports, ops, server.properties, readiness, teardown,
 * spawn) live in `./serverCommon.ts` and are reused by `./ModdedProvisioner.ts`.
 */
import { mkdirSync, writeFileSync, createWriteStream, existsSync, cpSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { hashFile } from "./sources.js";
import {
  findFreePort,
  offlineUuid,
  writeOps,
  writeServerProperties,
  hasWorldData,
  waitForReady,
  stopServer,
  spawnFromLaunch,
  type AgentSpec,
  type AgentEndpoint,
  type ProvisionedServer,
} from "./serverCommon.js";

// Re-exported so existing importers (index.ts, cli.ts) keep their import sites.
export { findFreePort, offlineUuid };
export type { AgentSpec, AgentEndpoint, ProvisionedServer };

export interface PluginSpec {
  path: string;
  as?: string;
}

export interface PaperProvisionOptions {
  mc: string;
  build?: number | "latest";
  /**
   * A pre-resolved, integrity-checked server jar (F2 native old-version support). When set, it
   * is booted as-is and the PaperMC fill API / Mojang fallback is bypassed — how a plugin-capable
   * old server the Paper API cannot serve (e.g. a checksummed Spigot/legacy 1.8.x jar) is
   * provisioned. Resolved by the CLI from a target's `server: { path | url, sha256 }`.
   */
  serverJar?: string;
  bindHost: string;
  gamePort: number;
  instanceDir: string;
  cacheDir: string;
  plugins: PluginSpec[];
  /** Server agents to install + wire to a second MCTP port (M3). */
  agents?: AgentSpec[];
  worldSnapshotPath?: string;
  levelName?: string;
  serverProps?: Record<string, string | number | boolean>;
  /** Usernames to grant operator on boot (written to ops.json with their offline UUID). */
  ops?: string[];
  eulaAccepted: boolean;
  javaPath?: string;
  bootTimeoutMs?: number;
  onLog?: (line: string) => void;
}

interface PaperBuild {
  id: number;
  downloads?: Record<string, { name?: string; url?: string; checksums?: { sha256?: string } }>;
}

/** Resolve + (cached) download the Paper server jar via the v3 fill API. */
export async function resolvePaperJar(
  mc: string,
  build: number | "latest",
  cacheDir: string,
): Promise<string> {
  const res = await fetch(`https://fill.papermc.io/v3/projects/paper/versions/${mc}/builds`);
  if (!res.ok) {
    throw new Error(`ARTIFACT_NOT_AVAILABLE: Paper builds for ${mc} (HTTP ${res.status})`);
  }
  const builds = (await res.json()) as PaperBuild[];
  if (!Array.isArray(builds) || builds.length === 0) {
    throw new Error(`ARTIFACT_NOT_AVAILABLE: no Paper build for ${mc}`);
  }
  const chosen =
    build === "latest" ? builds.reduce((a, b) => (b.id > a.id ? b : a)) : builds.find((b) => b.id === build);
  if (!chosen) throw new Error(`ARTIFACT_NOT_AVAILABLE: Paper build ${String(build)} for ${mc}`);
  const dl = chosen.downloads?.["server:default"];
  if (!dl?.url) throw new Error(`ARTIFACT_NOT_AVAILABLE: no server:default for Paper ${mc} #${chosen.id}`);

  mkdirSync(cacheDir, { recursive: true });
  const jarPath = join(cacheDir, dl.name ?? `paper-${mc}-${chosen.id}.jar`);
  const sha = dl.checksums?.sha256;
  if (existsSync(jarPath) && (!sha || (await hashFile(jarPath, "sha256")) === sha)) {
    return jarPath;
  }
  const dres = await fetch(dl.url);
  if (!dres.ok || !dres.body) throw new Error(`download failed: HTTP ${dres.status}`);
  await pipeline(Readable.fromWeb(dres.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(jarPath));
  if (sha) {
    const got = await hashFile(jarPath, "sha256");
    if (got !== sha) throw new Error(`ARTIFACT_CHECKSUM_MISMATCH: ${jarPath}`);
  }
  return jarPath;
}

interface MojangManifest {
  latest: { release: string; snapshot: string };
  versions: { id: string; url: string }[];
}
interface MojangPackage {
  downloads: { server?: { url: string; sha1: string } };
}

/**
 * Fallback resolver (ROADMAP §3.5): the Mojang piston version manifest. Note a
 * vanilla server cannot load Bukkit plugins, so this is for vanilla / rendered
 * client targets (M3+); for the canonical Paper plugin test the Paper API is the
 * primary path and this fires only if Paper has no build for `mc`.
 */
export async function resolveMojangServerJar(mc: string, cacheDir: string): Promise<string> {
  const manRes = await fetch("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json");
  if (!manRes.ok) throw new Error(`ARTIFACT_NOT_AVAILABLE: Mojang manifest (HTTP ${manRes.status})`);
  const manifest = (await manRes.json()) as MojangManifest;
  const id =
    mc === "latest-release" ? manifest.latest.release : mc === "latest-snapshot" ? manifest.latest.snapshot : mc;
  const entry = manifest.versions.find((v) => v.id === id);
  if (!entry) throw new Error(`ARTIFACT_NOT_AVAILABLE: Mojang has no version ${mc}`);
  const pkgRes = await fetch(entry.url);
  if (!pkgRes.ok) throw new Error(`ARTIFACT_NOT_AVAILABLE: Mojang package for ${mc} (HTTP ${pkgRes.status})`);
  const server = ((await pkgRes.json()) as MojangPackage).downloads.server;
  if (!server?.url) throw new Error(`ARTIFACT_NOT_AVAILABLE: no vanilla server jar for ${mc}`);

  mkdirSync(cacheDir, { recursive: true });
  const jarPath = join(cacheDir, `vanilla-${id}-server.jar`);
  if (existsSync(jarPath) && (!server.sha1 || (await hashFile(jarPath, "sha1")) === server.sha1)) {
    return jarPath;
  }
  const dres = await fetch(server.url);
  if (!dres.ok || !dres.body) throw new Error(`download failed: HTTP ${dres.status}`);
  await pipeline(Readable.fromWeb(dres.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(jarPath));
  if (server.sha1) {
    const got = await hashFile(jarPath, "sha1");
    if (got !== server.sha1) throw new Error(`ARTIFACT_CHECKSUM_MISMATCH: ${jarPath}`);
  }
  return jarPath;
}

/** Provision and boot a Paper server; resolves when it is ready to accept the bot. */
export async function provisionPaper(opts: PaperProvisionOptions): Promise<ProvisionedServer> {
  if (!opts.eulaAccepted) {
    throw new Error("EULA_NOT_ACCEPTED: set provision.eulaAccepted: true to boot a server");
  }

  let jar: string;
  if (opts.serverJar) {
    // F2 (native old-version): an explicit, integrity-checked server jar was supplied
    // (a target's `server: { path | url, sha256 }`). Boot it as-is, bypassing the PaperMC
    // fill API / Mojang fallback — this is how a plugin-capable old server the Paper API
    // cannot serve (e.g. a checksummed Spigot/legacy 1.8.x jar) is provisioned.
    jar = opts.serverJar;
  } else {
    try {
      jar = await resolvePaperJar(opts.mc, opts.build ?? "latest", opts.cacheDir);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("ARTIFACT_NOT_AVAILABLE")) {
        // A plugin target needs a Bukkit-capable server. The Mojang vanilla fallback CANNOT
        // load plugins, so booting it would fail every plugin step with a confusing error
        // (a near-false-negative). Signal an honest SKIP instead (F2). The vanilla fallback
        // remains for plugin-free targets (e.g. a rendered-client target's connect server).
        if (opts.plugins.length > 0) {
          throw new Error(
            `UNSUPPORTED_TARGET: no plugin-capable server for ${opts.mc} — PaperMC has no build and the ` +
              `vanilla fallback cannot load Bukkit plugins (${err.message})`,
          );
        }
        jar = await resolveMojangServerJar(opts.mc, opts.cacheDir);
      } else {
        throw err;
      }
    }
  }

  mkdirSync(opts.instanceDir, { recursive: true });
  mkdirSync(join(opts.instanceDir, "logs"), { recursive: true });
  mkdirSync(join(opts.instanceDir, "plugins"), { recursive: true });

  writeFileSync(join(opts.instanceDir, "eula.txt"), "eula=true\n");
  writeServerProperties({
    instanceDir: opts.instanceDir,
    gamePort: opts.gamePort,
    bindHost: opts.bindHost,
    ...(opts.levelName ? { levelName: opts.levelName } : {}),
    ...(opts.serverProps ? { serverProps: opts.serverProps } : {}),
  });
  if (opts.ops?.length) writeOps(opts.instanceDir, opts.ops);

  const level = opts.levelName ?? "world";
  if (opts.worldSnapshotPath && existsSync(opts.worldSnapshotPath) && hasWorldData(opts.worldSnapshotPath)) {
    cpSync(opts.worldSnapshotPath, join(opts.instanceDir, level), { recursive: true });
  }

  for (const plugin of opts.plugins) {
    const src = resolve(plugin.path);
    if (!existsSync(src)) throw new Error(`plugin not found: ${src} (build the SUT first — plugin jars are not committed)`);
    cpSync(src, join(opts.instanceDir, "plugins", plugin.as ?? basename(src)));
  }

  // Install each server agent (M3): drop its jar into plugins/ and write its
  // dedicated MCTP port to plugins/mc-test-agent/config.yml. The agent reads the
  // port from config on enable and logs "MCTP listening on :PORT".
  const agents = opts.agents ?? [];
  for (const agent of agents) {
    const src = resolve(agent.jarPath);
    if (!existsSync(src)) throw new Error(`agent jar not found: ${src} (build agent '${agent.name}' first)`);
    cpSync(src, join(opts.instanceDir, "plugins", basename(src)));
    const agentConfigDir = join(opts.instanceDir, "plugins", "mc-test-agent");
    mkdirSync(agentConfigDir, { recursive: true });
    writeFileSync(join(agentConfigDir, "config.yml"), `port: ${agent.port}\n`);
  }

  const logPath = join(opts.instanceDir, "logs", "server.log");
  const logStream = createWriteStream(logPath);
  const proc = spawnFromLaunch({
    kind: "jar",
    java: opts.javaPath ?? "java",
    jvmArgs: ["-Xms1G", "-Xmx2G"],
    jar,
    programArgs: ["nogui"],
    cwd: opts.instanceDir,
  });

  try {
    await waitForReady(
      proc,
      logStream,
      opts.onLog,
      opts.bootTimeoutMs ?? 240000,
      agents.map((agent) => agent.port),
    );
  } catch (err) {
    await stopServer(proc).catch(() => {});
    throw err;
  }

  // Each agent listens on its assigned port at the canonical MCTP path. waitForReady above only
  // resolves once every agent has logged "MCTP listening on :PORT", so each endpoint is bound.
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
    stop: async () => {
      await stopServer(proc);
      // Await the log stream's close so its file handle is released before any
      // post-run cleanup tries to remove the instance dir (matters on Windows,
      // where an open handle blocks rmSync).
      await new Promise<void>((res) => logStream.end(() => res()));
    },
  };
}
