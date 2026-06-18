/**
 * Shared server-provisioning primitives used by BOTH the Bukkit-family provisioner
 * (`PaperProvisioner`) and the modded-loader provisioner (`ModdedProvisioner`):
 * port allocation, offline-UUID/ops, `server.properties`, the boot readiness gate
 * (now with boot-log mod-load detection, F5), graceful teardown, and a
 * loader-agnostic `spawnFromLaunch`. Extracted so the modded path reuses the exact
 * same isolation/determinism/readiness discipline as the Paper path.
 */
import { writeFileSync, existsSync, readdirSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import type { ModLoad } from "../model/result.js";

// Re-exported so provisioners/CLI can import the boot-log mod-load type from here.
export type { ModLoad };

/**
 * A server agent to install alongside the SUT: its built jar dropped into the
 * server's plugin/mod dir, listening on its own `port` (a second MCTP port,
 * distinct from the game port). Bukkit agents read the port from a config file;
 * modded agents read it from the `MCTEST_AGENT_PORT` env var.
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

export interface ProvisionedServer {
  host: string;
  port: number;
  logPath: string;
  instanceDir: string;
  /** Resolved server-agent MCTP endpoints (one per installed agent). */
  agentEndpoints: AgentEndpoint[];
  /** Boot-log mod-load detection result (F5), when the target declared `expectMods`. */
  modLoad?: ModLoad;
  stop: () => Promise<void>;
}

// Runner-owned keys a target's serverProps cannot override (ENVIRONMENTS.md §2.7).
export const FORCED_PROPS = new Set([
  "online-mode",
  "server-port",
  "server-ip",
  "level-name",
  "level-type",
  "spawn-protection",
  "sync-chunk-writes",
]);

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

/**
 * Bukkit's offline-player UUID for `name`: `UUID.nameUUIDFromBytes("OfflinePlayer:" + name)`
 * — an MD5 (type-3) UUID over UTF-8 bytes. Servers boot `online-mode=false` (§2.7), so this is
 * the UUID the bot actually joins with; ops.json must carry it for the op grant to apply.
 */
export function offlineUuid(name: string): string {
  const h = createHash("md5").update(`OfflinePlayer:${name}`, "utf8").digest();
  h[6] = (h[6]! & 0x0f) | 0x30; // version 3
  h[8] = (h[8]! & 0x3f) | 0x80; // IETF variant
  const s = h.toString("hex");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

/**
 * Write `ops.json` granting operator (level 4) to each name. Written before boot so it is read
 * on first start — race-free. Used identically by Bukkit and vanilla/modded servers.
 */
export function writeOps(instanceDir: string, ops: string[]): void {
  const entries = ops.map((name) => ({
    uuid: offlineUuid(name),
    name,
    level: 4,
    bypassesPlayerLimit: false,
  }));
  writeFileSync(join(instanceDir, "ops.json"), `${JSON.stringify(entries, null, 2)}\n`);
}

/** The minimal inputs for `server.properties` (loader-agnostic). */
export interface ServerPropsConfig {
  instanceDir: string;
  gamePort: number;
  bindHost: string;
  levelName?: string;
  serverProps?: Record<string, string | number | boolean>;
}

/**
 * Write a deterministic, offline `server.properties`. Identical for Bukkit and
 * vanilla/modded servers — the loader differences live in the world layout + boot
 * command, not the properties file. Runner-owned keys (§2.7) always win.
 */
export function writeServerProperties(cfg: ServerPropsConfig): void {
  const props: Record<string, string> = {
    "online-mode": "false",
    "server-port": String(cfg.gamePort),
    "server-ip": cfg.bindHost,
    "level-name": cfg.levelName ?? "world",
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
  for (const [k, v] of Object.entries(cfg.serverProps ?? {})) {
    if (!FORCED_PROPS.has(k)) props[k] = String(v);
  }
  const text = `${Object.entries(props)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n")}\n`;
  writeFileSync(join(cfg.instanceDir, "server.properties"), text);
}

/** True if a snapshot dir holds real world data (not just a README placeholder). */
export function hasWorldData(dir: string): boolean {
  try {
    return existsSync(join(dir, "level.dat")) || readdirSync(dir).some((f) => f !== "README.md");
  } catch {
    return false;
  }
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Best-effort list of mod ids the loader printed at startup (PURE, unit-tested).
 * Fabric/Quilt print a `Loading N mods:` block with `- <id> <version>` entries
 * (sub-mods indented `--`); that yields a rich list. Forge/NeoForge's FML output
 * is version-variable, so we return the Fabric-style matches only and rely on the
 * per-expected-id presence check in `modLoadResult` for those loaders.
 */
export function parseLoadedMods(logText: string, loader: string): string[] {
  const fam = loader.toLowerCase();
  const ids = new Set<string>();
  if (fam === "fabric" || fam === "quilt") {
    const re = /(?:^|[\r\n])\s*-{1,2}\s+([a-z0-9][a-z0-9_.-]*)\s+[^\r\n]+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(logText)) !== null) ids.add(m[1]!);
  }
  return [...ids];
}

/**
 * Compute the boot-log mod-load result (PURE, unit-tested). An expected id counts
 * as `seen` when it appears in `parseLoadedMods` OR as a word-boundary token in the
 * log (covers Forge/NeoForge, whose FML logs the id but not in a uniform list).
 */
export function modLoadResult(logText: string, loader: string, expected: string[]): ModLoad {
  const all = parseLoadedMods(logText, loader);
  const allSet = new Set(all);
  const seen = expected.filter((id) => allSet.has(id) || new RegExp(`\\b${esc(id)}\\b`, "i").test(logText));
  const missing = expected.filter((id) => !seen.includes(id));
  return { loader, expected, seen, missing, all };
}

/**
 * Resolves when the server has booted (`Done (`) AND every co-installed agent has bound its MCTP
 * port (`MCTP listening on :PORT`). When `modOpts` is given it also captures the startup log and
 * returns the boot-log mod-load detection (F5). A trailing agent line is awaited up to
 * `bootTimeoutMs`; if an agent never binds, fail with a precise BOOT_TIMEOUT.
 */
export function waitForReady(
  proc: ChildProcess,
  logStream: WriteStream,
  onLog: ((line: string) => void) | undefined,
  bootTimeoutMs: number,
  expectedAgentPorts: number[] = [],
  modOpts: { expectModIds?: string[]; loader?: string } = {},
): Promise<{ modLoad?: ModLoad }> {
  return new Promise((resolveReady, reject) => {
    let resolved = false;
    let serverDone = false;
    let buffer = "";
    // A separate, larger startup buffer for mod-list parsing (mods load BEFORE
    // `Done (`, so they must survive the `buffer` truncation). Capped at 1 MB.
    let modBuf = "";
    const wantMods = (modOpts.expectModIds?.length ?? 0) > 0 || modOpts.loader !== undefined;
    const pendingPorts = new Set(expectedAgentPorts);
    const listening = /MCTP listening on :(\d+)/g;

    const computeModLoad = (): ModLoad | undefined =>
      wantMods && modOpts.loader ? modLoadResult(modBuf, modOpts.loader, modOpts.expectModIds ?? []) : undefined;

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
        resolveReady({ ...(computeModLoad() ? { modLoad: computeModLoad() } : {}) });
      }
    };

    const onData = (chunk: Buffer): void => {
      const s = chunk.toString();
      logStream.write(s);
      onLog?.(s);
      if (resolved) return;
      buffer += s;
      if (wantMods && modBuf.length < 1_000_000) modBuf += s;
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

/** Gracefully stop a server process (console `stop`, then SIGKILL after 15s). */
export async function stopServer(proc: ChildProcess): Promise<void> {
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

/**
 * A loader-agnostic launch spec recorded so boot + teardown are uniform across
 * Bukkit (`-jar paper.jar nogui`), Fabric (`-jar fabric-server-launch.jar nogui`),
 * and Forge/NeoForge (`@libraries/.../<os>_args.txt nogui` — an `@args` file).
 */
export interface LaunchSpec {
  kind: "jar" | "argsFile";
  java: string;
  jvmArgs: string[];
  /** Server jar for `kind: "jar"`. */
  jar?: string;
  /** Program args after the jar / before/with the `@args` file (e.g. `["nogui"]`). */
  programArgs: string[];
  cwd: string;
  /** Extra environment for the process (e.g. `MCTEST_AGENT_PORT` for modded agents). */
  env?: Record<string, string>;
}

/** Spawn a server process from a `LaunchSpec` (stdio piped for the readiness scan). */
export function spawnFromLaunch(launch: LaunchSpec): ChildProcess {
  const args =
    launch.kind === "jar"
      ? [...launch.jvmArgs, "-jar", launch.jar!, ...launch.programArgs]
      : [...launch.jvmArgs, ...launch.programArgs];
  return spawn(launch.java, args, {
    cwd: launch.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    ...(launch.env ? { env: { ...process.env, ...launch.env } } : {}),
  });
}
