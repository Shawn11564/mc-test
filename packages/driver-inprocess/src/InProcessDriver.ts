/**
 * The in-process driver: the runner-side adapter that **launches and babysits a
 * rendered Minecraft client** hosting the client MCTP agent, then hands the
 * runner the agent's ws URL. The runner connects to that agent exactly as it
 * would to any JVM agent — there is no in-process shortcut on the wire.
 *
 * The real `start()` (no injected seams) starts/reuses a display backend
 * (Xvfb/desktop), PROVISIONS the client (downloads Minecraft + Fabric, stages the
 * SUT mods + the client agent jar into a fresh `mods/`), builds the real
 * `java … KnotClient …` launch, spawns it, and scrapes `MCTP listening on :PORT`
 * from the client log to learn the agent port. It needs a real framebuffer
 * (Xvfb in Linux CI / a desktop runner) + the Loom-built jars — so it runs in the
 * GL-capable E2E lane, not the offline fast lane. Unit tests inject `opts.provision`,
 * `opts.startDisplaySession`, and `opts.spawn` so the wiring is exercised with no
 * network, no display, and no client.
 */
import {
  startDisplay,
  type DisplayBackend,
  type DisplaySession,
} from "./launch/Display.js";
import { buildClientLaunch } from "./launch/ClientLauncher.js";
import { provisionClient, type ProvisionOptions } from "./launch/ClientProvisioner.js";
import type { ResolvedClient } from "./launch/ClientLauncher.js";
import { join } from "node:path";

/** The shape `opts.spawn` (and the real spawner) must satisfy. */
export interface SpawnedClient {
  /** The MCTP ws url the client agent is listening on. */
  url: string;
  /** Tear the client down. */
  stop: () => Promise<void>;
}

/** A built launch invocation handed to the spawner. */
export interface ClientLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** Extra knobs for the real spawner (log capture + readiness budget). */
export interface SpawnContext {
  /** Where to tee the client's stdout/stderr (the `client.log` DRIVERS.md scrapes). */
  logFile?: string;
  /** Fail if `MCTP listening` is not seen within this budget (default 180s). */
  readyTimeoutMs?: number;
  onLog?: (line: string) => void;
  /**
   * The client's per-instance game dir. Used ONLY as the last-resort teardown marker: it appears
   * in the client JVM's own command line, so it identifies this client precisely even if the
   * spawned pid is no longer the live process.
   */
  gameDir?: string;
}

/** Options for an in-process (rendered-client) launch. */
export interface InProcessLaunchOptions {
  mc?: string;
  loader?: string;
  mods?: string[];
  clientAgentJar?: string;
  display?: DisplayBackend;
  windowSize?: string;
  /** Pin the Fabric loader version (else newest stable for `mc`). */
  loaderVersion?: string;
  /** Shared content cache for downloaded MC/Fabric (defaults under `~/.mc-test`). */
  cacheDir?: string;
  /** Per-instance game-dir root (each launch gets its own `mods/`). */
  workDir?: string;
  /** `java` to launch the client with (default `"java"`; MC 1.21 needs Java 21). */
  javaPath?: string;
  /** Skip the (large) asset download — resolution-only (tests / dry runs). */
  downloadAssets?: boolean;
  onLog?: (line: string) => void;
  /**
   * The MCTP port the launched client agent should bind (passed via
   * `MCTEST_AGENT_PORT`). Omit and the driver allocates a free loopback port per
   * instance — without it every client falls back to the agent's fixed default
   * (25599) and two parallel in-process targets collide on the same port.
   */
  agentPort?: number;
  /** Test seam: provide a client (skips the real download). */
  provision?: (opts: ProvisionOptions) => Promise<ResolvedClient>;
  /** Test seam: provide a display session (skips real Xvfb). */
  startDisplaySession?: typeof startDisplay;
  /** Test/seam hook: inject a process spawner returning a live MCTP url
   *  (default = real launch, needs a rendered client). */
  spawn?: (launch: ClientLaunch, ctx: SpawnContext) => Promise<SpawnedClient>;
}

/** Regex that learns the client agent port from its readiness line. */
const MCTP_LISTENING = /MCTP listening on :(\d+)/;

/** Allocate a free loopback TCP port (OS-assigned) for the client agent to bind. */
async function findFreePort(): Promise<number> {
  const net = await import("node:net");
  return new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

const DEFAULT_MC = "1.21.1";
const DEFAULT_LOADER = "fabric";

function parseSize(windowSize: string | undefined): { width: number; height: number } {
  const [w, h] = (windowSize ?? "1280x720").split("x");
  return { width: Number(w ?? 1280) || 1280, height: Number(h ?? 720) || 720 };
}

/**
 * One in-process driver instance launches one rendered client and exposes its
 * client-agent MCTP endpoint. Construct, `start()` to get the ws URL, then
 * `stop()` to tear the client (and any managed display) down.
 */
export class InProcessDriver {
  private readonly opts: InProcessLaunchOptions;
  private spawned: SpawnedClient | null = null;
  private display: DisplaySession | null = null;
  private url = "";

  constructor(opts: InProcessLaunchOptions = {}) {
    this.opts = opts;
  }

  /**
   * Start the display, provision + launch the rendered client (mods staged,
   * offline auth), learn its agent port, and return the agent ws url.
   */
  async start(): Promise<{ url: string }> {
    const platform = process.platform;
    const log = this.opts.onLog ?? (() => {});
    const { width, height } = parseSize(this.opts.windowSize);

    // 1) Display: managed Xvfb (Linux, no ambient DISPLAY) / reuse / desktop.
    const startDisplaySession = this.opts.startDisplaySession ?? startDisplay;
    this.display = await startDisplaySession({
      platform,
      ...(this.opts.display ? { pref: this.opts.display } : {}),
      width,
      height,
    });

    // 2) Allocate a per-instance MCTP port (unless one was pinned) so parallel
    //    in-process targets never collide on the agent's fixed default.
    const agentPort = this.opts.agentPort ?? (await findFreePort());

    // 3) Provision: download MC + Fabric, stage the SUT mods + client agent jar.
    const provision = this.opts.provision ?? provisionClient;
    const client = await provision({
      mc: this.opts.mc ?? DEFAULT_MC,
      loader: this.opts.loader ?? DEFAULT_LOADER,
      mods: this.opts.mods ?? [],
      ...(this.opts.clientAgentJar ? { clientAgentJar: this.opts.clientAgentJar } : {}),
      ...(this.opts.cacheDir ? { cacheDir: this.opts.cacheDir } : {}),
      ...(this.opts.workDir ? { workDir: this.opts.workDir } : {}),
      ...(this.opts.loaderVersion ? { loaderVersion: this.opts.loaderVersion } : {}),
      ...(this.opts.javaPath ? { javaPath: this.opts.javaPath } : {}),
      ...(this.opts.downloadAssets !== undefined ? { downloadAssets: this.opts.downloadAssets } : {}),
      platform,
      onLog: log,
    });

    // 4) Build the real launch (offline identity + display env + agent port).
    const launch = buildClientLaunch({
      client,
      display: this.display.choice,
      agentPort,
      ...(this.opts.windowSize ? { windowSize: this.opts.windowSize } : {}),
    });

    // 5) Spawn the client; scrape its readiness line for the bound MCTP port.
    const spawner = this.opts.spawn ?? defaultSpawn;
    this.spawned = await spawner(launch, {
      logFile: join(client.gameDir, "client.log"),
      gameDir: client.gameDir,
      onLog: log,
    });
    this.url = this.spawned.url;
    return { url: this.url };
  }

  /** The MCTP endpoint URL (valid after `start`). */
  get endpoint(): string {
    return this.url;
  }

  /** Tear down the rendered client (and its agent), then the managed display. */
  async stop(): Promise<void> {
    if (this.spawned) {
      const spawned = this.spawned;
      this.spawned = null;
      await spawned.stop();
    }
    if (this.display) {
      const display = this.display;
      this.display = null;
      await display.stop();
    }
  }
}

/**
 * The real spawner: spawn the provisioned client, tee stdout+stderr to
 * `client.log`, scrape `MCTP listening on :PORT` to learn the agent port, and
 * resolve to `ws://127.0.0.1:PORT/mctp`. Fails fast if the client exits or the
 * readiness budget elapses. Unit tests inject `opts.spawn` instead.
 */
async function defaultSpawn(launch: ClientLaunch, ctx: SpawnContext): Promise<SpawnedClient> {
  const { spawn } = await import("node:child_process");
  const { createWriteStream } = await import("node:fs");
  const child = spawn(launch.command, launch.args, {
    env: { ...process.env, ...launch.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const logStream = ctx.logFile ? createWriteStream(ctx.logFile, { flags: "a" }) : null;
  const onLog = ctx.onLog ?? (() => {});
  const timeoutMs = ctx.readyTimeoutMs ?? 180_000;

  // Record the exact launch invocation at the top of the client log — invaluable when a modular
  // (Forge/NeoForge) BootstrapLauncher boot fails on classpath/module-path layout.
  logStream?.write(`=== mc-test client launch ===\n${launch.command} \\\n  ${launch.args.join(" \\\n  ")}\n=== end launch ===\n`);

  const port = await new Promise<number>((resolve, reject) => {
    let buffer = "";
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onData);
      fn();
    };
    const onData = (chunk: Buffer): void => {
      const text = chunk.toString();
      logStream?.write(text);
      buffer += text;
      const m = MCTP_LISTENING.exec(buffer);
      if (m && m[1]) finish(() => resolve(Number(m[1])));
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(`client agent not ready within ${timeoutMs}ms (no 'MCTP listening')`))),
      timeoutMs,
    );
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("error", (e) => finish(() => reject(e)));
    child.once("exit", (code) =>
      finish(() => reject(new Error(`client exited before MCTP came up (code ${code ?? "?"})`))),
    );
    onLog(`launched rendered client: ${launch.command} (pid ${child.pid ?? "?"})`);
  });

  return {
    url: `ws://127.0.0.1:${port}/mctp`,
    stop: () => stopClientProcess(child, logStream, onLog, ctx.gameDir),
  };
}

/**
 * Tear down the rendered client for real.
 *
 * A plain `child.kill()` + "wait for `exit`" is not enough here, and getting it wrong is
 * expensive: a surviving client keeps the extracted GLFW/LWJGL natives mapped, so the NEXT
 * rendered run fails to re-stage them (`EBUSY … glfw.dll` on Windows) — a leak that reads as
 * a flaky rendered lane rather than as the resource problem it is. So:
 *
 *  1. ask nicely (`SIGTERM`) and give the JVM a moment to run its shutdown hooks;
 *  2. escalate to `SIGKILL`, and on Windows to `taskkill /T /F`, which kills the whole tree
 *     (Node's `kill()` only targets the process it spawned);
 *  3. NEVER hang — resolve after the budget either way, and SURFACE a surviving pid instead of
 *     swallowing it, matching how the workspace GC surfaces an undeletable env dir.
 */
async function stopClientProcess(
  child: import("node:child_process").ChildProcess,
  logStream: { end: () => void } | null,
  onLog: (line: string) => void,
  gameDir?: string,
): Promise<void> {
  const pid = child.pid;
  /**
   * Liveness from the OS, NOT from Node's bookkeeping. `child.exitCode`/`signalCode` report
   * what Node believes about the pipe it holds, and for a rendered Minecraft client that can
   * read "exited" while the JVM is very much alive — which is precisely how the leak hid: every
   * escalation below was skipped because the driver thought the job was already done.
   * `process.kill(pid, 0)` sends no signal and throws `ESRCH` only when the pid is really gone.
   */
  const alive = (): boolean => {
    if (pid === undefined) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const wait = async (ms: number): Promise<void> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline && alive()) {
      await new Promise<void>((r) => setTimeout(r, 100));
    }
  };

  try {
    child.kill("SIGTERM");
  } catch {
    /* already gone */
  }
  await wait(3000);

  if (alive()) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    await wait(2000);
  }

  // Windows: Node's kill can miss a JVM whose console handle it no longer owns, and it never
  // reaps grandchildren. taskkill /T /F is the reliable tree kill.
  const { spawnSync } = await import("node:child_process");
  if (alive() && process.platform === "win32" && pid !== undefined) {
    try {
      spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore" });
    } catch {
      /* taskkill unavailable — fall through */
    }
    await wait(2000);
  }

  // ALWAYS sweep by the client's own game dir — not only when the spawned pid is still alive.
  // The launcher RE-EXECS: the java we spawn hands off to a second JVM and exits, so the pid we
  // hold is gone while the real client keeps running (and keeps the natives mapped, breaking the
  // next rendered run with EBUSY on glfw.dll). A pid-based teardown can therefore look like it
  // succeeded while leaking the actual client — which is exactly how this hid.
  //
  // The game dir is per-instance and appears in the client JVM's own command line, so matching on
  // it is precise: it can only ever name THIS client, never another run's and never an unrelated
  // JVM (a Gradle daemon, the server).
  if (gameDir) {
    killByGameDir(spawnSync, gameDir);
    await new Promise<void>((r) => setTimeout(r, 500));
    const survivors = countByGameDir(spawnSync, gameDir);
    logStream?.end();
    if (survivors > 0) {
      // Surface it rather than swallow it: a surviving client will break the next rendered run.
      onLog(
        `⚠ ${survivors} rendered-client process(es) for ${gameDir} did not exit; they still hold the ` +
          `extracted natives and will break the next rendered run with EBUSY on glfw/lwjgl`,
      );
    }
    return;
  }

  logStream?.end();
  if (alive()) {
    onLog(
      `⚠ rendered client (pid ${pid ?? "?"}) did not exit; it still holds the extracted natives and ` +
        `will break the next rendered run with EBUSY on glfw/lwjgl — kill it manually`,
    );
  }
}

/** PowerShell/`pgrep` predicate matching only the JVMs launched with this game dir. */
function gameDirFilter(gameDir: string): string {
  return `Get-CimInstance Win32_Process -Filter "Name='java.exe'" | Where-Object { $_.CommandLine -like '*${gameDir.replace(/'/g, "''")}*' }`;
}

/** Force-kill every JVM running with this game dir. Best-effort; never throws. */
function killByGameDir(spawnSync: typeof import("node:child_process").spawnSync, gameDir: string): void {
  try {
    if (process.platform === "win32") {
      spawnSync(
        "powershell",
        ["-NoProfile", "-Command", `${gameDirFilter(gameDir)} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`],
        { stdio: "ignore" },
      );
    } else {
      spawnSync("pkill", ["-9", "-f", gameDir], { stdio: "ignore" });
    }
  } catch {
    /* no shell helper available — the caller reports any survivors */
  }
}

/** How many JVMs are still running with this game dir (0 when the helper is unavailable). */
function countByGameDir(spawnSync: typeof import("node:child_process").spawnSync, gameDir: string): number {
  try {
    const r =
      process.platform === "win32"
        ? spawnSync("powershell", ["-NoProfile", "-Command", `@(${gameDirFilter(gameDir)}).Count`], {
            encoding: "utf8",
          })
        : spawnSync("pgrep", ["-fc", gameDir], { encoding: "utf8" });
    const n = Number.parseInt((r.stdout ?? "").trim(), 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}
