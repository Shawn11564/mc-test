/**
 * Minimal M2 provisioner: download a Paper jar (PaperMC fill API), write an
 * offline `server.properties` + `eula.txt`, copy the world snapshot, drop the
 * SUT plugin, boot the server, wait for "Done (", and expose a teardown hook.
 *
 * Full Testcontainers/Docker + agent installation are M3+ — intentionally not here.
 */
import {
  mkdirSync,
  writeFileSync,
  createWriteStream,
  existsSync,
  cpSync,
  readdirSync,
} from "node:fs";
import { join, resolve, basename } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { createServer } from "node:net";

export interface PluginSpec {
  path: string;
  as?: string;
}

/**
 * A server agent to install alongside the SUT (M3): its built jar dropped into
 * `plugins/`, listening on its own `port` (a second MCTP port distinct from the
 * game port). The agent reads its port from `plugins/mc-test-agent/config.yml`.
 */
export interface AgentSpec {
  name: string;
  jarPath: string;
  port: number;
}

/** A resolved server-agent MCTP endpoint after boot. */
export interface AgentEndpoint {
  name: string;
  url: string;
}

export interface PaperProvisionOptions {
  mc: string;
  build?: number | "latest";
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
  eulaAccepted: boolean;
  javaPath?: string;
  bootTimeoutMs?: number;
  onLog?: (line: string) => void;
}

export interface ProvisionedServer {
  host: string;
  port: number;
  logPath: string;
  instanceDir: string;
  /** Resolved server-agent MCTP endpoints (one per installed agent). */
  agentEndpoints: AgentEndpoint[];
  stop: () => Promise<void>;
}

// Runner-owned keys a target's serverProps cannot override (ENVIRONMENTS.md §2.7).
const FORCED_PROPS = new Set([
  "online-mode",
  "server-port",
  "server-ip",
  "level-name",
  "level-type",
  "spawn-protection",
  "sync-chunk-writes",
]);

function hashFile(path: string, algo: "sha256" | "sha1"): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash(algo);
    createReadStream(path)
      .on("data", (d) => hash.update(d))
      .on("end", () => resolveHash(hash.digest("hex")))
      .on("error", reject);
  });
}

/** Find a free TCP port at or above `from` (probes by binding on `host`). */
export async function findFreePort(host: string, from: number, to: number): Promise<number> {
  for (let port = from; port <= to; port++) {
    const free = await new Promise<boolean>((res) => {
      const srv = createServer();
      srv.once("error", () => res(false));
      srv.once("listening", () => srv.close(() => res(true)));
      srv.listen(port, host);
    });
    if (free) return port;
  }
  throw new Error(`PORT_EXHAUSTED: no free port in [${from}, ${to}] on ${host}`);
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

function writeServerProperties(opts: PaperProvisionOptions): void {
  const props: Record<string, string> = {
    "online-mode": "false",
    "server-port": String(opts.gamePort),
    "server-ip": opts.bindHost,
    "level-name": opts.levelName ?? "world",
    "level-type": "minecraft:flat",
    "generate-structures": "false",
    "spawn-protection": "0",
    "spawn-monsters": "false",
    "spawn-npcs": "false",
    "spawn-animals": "false",
    difficulty: "peaceful",
    gamemode: "creative",
    "allow-nether": "false",
    "view-distance": "4",
    "simulation-distance": "4",
    "max-players": "8",
    motd: "mc-test",
    "enable-command-block": "false",
    "sync-chunk-writes": "true",
  };
  for (const [k, v] of Object.entries(opts.serverProps ?? {})) {
    if (!FORCED_PROPS.has(k)) props[k] = String(v);
  }
  const text = `${Object.entries(props)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n")}\n`;
  writeFileSync(join(opts.instanceDir, "server.properties"), text);
}

function hasWorldData(dir: string): boolean {
  try {
    return existsSync(join(dir, "level.dat")) || readdirSync(dir).some((f) => f !== "README.md");
  } catch {
    return false;
  }
}

/**
 * Resolves when the server has booted (`Done (`) AND every co-installed agent has bound its MCTP
 * port (`MCTP listening on :PORT`) — the readiness gate the runner relies on before connecting the
 * agent session. A trailing agent line (the WS bind is async, sometimes just after `Done (`) is
 * awaited up to `bootTimeoutMs`; if an agent never binds, fail with a precise BOOT_TIMEOUT rather
 * than returning a half-ready target.
 */
function waitForReady(
  proc: ChildProcess,
  logStream: ReturnType<typeof createWriteStream>,
  onLog: ((line: string) => void) | undefined,
  bootTimeoutMs: number,
  expectedAgentPorts: number[] = [],
): Promise<void> {
  return new Promise((resolveReady, reject) => {
    let resolved = false;
    let serverDone = false;
    let buffer = "";
    const pendingPorts = new Set(expectedAgentPorts);
    const listening = /MCTP listening on :(\d+)/g;

    const timer = setTimeout(() => {
      if (resolved) return;
      reject(
        new Error(
          serverDone
            ? `BOOT_TIMEOUT: server agent(s) never bound MCTP port(s) ${[...pendingPorts].join(", ")}`
            : "BOOT_TIMEOUT: server did not reach 'Done' in time",
        ),
      );
    }, bootTimeoutMs);

    const finish = (): void => {
      if (!resolved && serverDone && pendingPorts.size === 0) {
        resolved = true;
        clearTimeout(timer);
        resolveReady();
      }
    };

    const onData = (chunk: Buffer): void => {
      const s = chunk.toString();
      logStream.write(s);
      onLog?.(s);
      if (resolved) return;
      buffer += s;
      if (!serverDone && buffer.includes("Done (")) serverDone = true;
      if (pendingPorts.size) {
        let m: RegExpExecArray | null;
        while ((m = listening.exec(buffer)) !== null) pendingPorts.delete(Number(m[1]));
        listening.lastIndex = 0;
      }
      if (buffer.length > 200000) buffer = buffer.slice(-50000);
      finish();
    };
    // The agent logs via the server console — scan both streams so a line on either is caught.
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    proc.once("exit", (code) => {
      if (!resolved) {
        clearTimeout(timer);
        reject(new Error(`server exited before ready (code ${code ?? "?"})`));
      }
    });
  });
}

async function stopServer(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  try {
    proc.stdin?.write("stop\n");
  } catch {
    /* may already be gone */
  }
  await new Promise<void>((res) => {
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      res();
    }, 15000);
    proc.once("exit", () => {
      clearTimeout(timer);
      res();
    });
  });
}

/** Provision and boot a Paper server; resolves when it is ready to accept the bot. */
export async function provisionPaper(opts: PaperProvisionOptions): Promise<ProvisionedServer> {
  if (!opts.eulaAccepted) {
    throw new Error("EULA_NOT_ACCEPTED: set provision.eulaAccepted: true to boot a server");
  }

  let jar: string;
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

  mkdirSync(opts.instanceDir, { recursive: true });
  mkdirSync(join(opts.instanceDir, "logs"), { recursive: true });
  mkdirSync(join(opts.instanceDir, "plugins"), { recursive: true });

  writeFileSync(join(opts.instanceDir, "eula.txt"), "eula=true\n");
  writeServerProperties(opts);

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
  const proc = spawn(opts.javaPath ?? "java", ["-Xms1G", "-Xmx2G", "-jar", jar, "nogui"], {
    cwd: opts.instanceDir,
    stdio: ["pipe", "pipe", "pipe"],
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
