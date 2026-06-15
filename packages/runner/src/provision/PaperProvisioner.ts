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

export interface PaperProvisionOptions {
  mc: string;
  build?: number | "latest";
  bindHost: string;
  gamePort: number;
  instanceDir: string;
  cacheDir: string;
  plugins: PluginSpec[];
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

function waitForReady(
  proc: ChildProcess,
  logStream: ReturnType<typeof createWriteStream>,
  onLog: ((line: string) => void) | undefined,
  bootTimeoutMs: number,
): Promise<void> {
  return new Promise((resolveReady, reject) => {
    let ready = false;
    let buffer = "";
    const timer = setTimeout(() => {
      if (!ready) reject(new Error("BOOT_TIMEOUT: server did not reach 'Done' in time"));
    }, bootTimeoutMs);

    const onData = (chunk: Buffer): void => {
      const s = chunk.toString();
      logStream.write(s);
      onLog?.(s);
      if (!ready) {
        buffer += s;
        if (buffer.includes("Done (")) {
          ready = true;
          clearTimeout(timer);
          resolveReady();
        }
        if (buffer.length > 200000) buffer = buffer.slice(-50000);
      }
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", (c: Buffer) => logStream.write(c.toString()));
    proc.once("exit", (code) => {
      if (!ready) {
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
    // Fall back to the Mojang version manifest when Paper has no build (ROADMAP §3.5).
    if (err instanceof Error && err.message.startsWith("ARTIFACT_NOT_AVAILABLE")) {
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
    if (!existsSync(src)) throw new Error(`plugin not found: ${src}`);
    cpSync(src, join(opts.instanceDir, "plugins", plugin.as ?? basename(src)));
  }

  const logPath = join(opts.instanceDir, "logs", "server.log");
  const logStream = createWriteStream(logPath);
  const proc = spawn(opts.javaPath ?? "java", ["-Xms1G", "-Xmx2G", "-jar", jar, "nogui"], {
    cwd: opts.instanceDir,
    stdio: ["pipe", "pipe", "pipe"],
  });

  try {
    await waitForReady(proc, logStream, opts.onLog, opts.bootTimeoutMs ?? 240000);
  } catch (err) {
    await stopServer(proc).catch(() => {});
    throw err;
  }

  return {
    host: opts.bindHost,
    port: opts.gamePort,
    logPath,
    instanceDir: opts.instanceDir,
    stop: async () => {
      await stopServer(proc);
      logStream.end();
    },
  };
}
