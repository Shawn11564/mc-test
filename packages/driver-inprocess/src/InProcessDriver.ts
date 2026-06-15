/**
 * The in-process driver: the runner-side adapter that **launches and babysits a
 * rendered Minecraft client** hosting the client MCTP agent, then hands the
 * runner the agent's ws URL. The runner connects to that agent exactly as it
 * would to any JVM agent — there is no in-process shortcut on the wire.
 *
 * The real `start()` (no injected `spawn`) selects a display backend, builds the
 * offline launch, spawns the client, and scrapes `MCTP listening on :PORT` from
 * its stdout to learn the agent port. That path needs a *provisioned* rendered
 * client (Loom/launcher) + a framebuffer (Xvfb/desktop) and is **acceptance-only**
 * — this environment cannot boot a real client. Unit tests inject `opts.spawn`,
 * a stub that returns a live MCTP url with no client.
 */
import { selectDisplay, type DisplayBackend, type DisplayChoice } from "./launch/Display.js";
import { buildClientLaunch, type ClientLaunchSpec } from "./launch/ClientLauncher.js";

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

/** Options for an in-process (rendered-client) launch. */
export interface InProcessLaunchOptions {
  mc?: string;
  loader?: string;
  mods?: string[];
  clientAgentJar?: string;
  display?: DisplayBackend;
  windowSize?: string;
  /**
   * The MCTP port the launched client agent should bind (passed via
   * `MCTEST_AGENT_PORT`). Omit and the driver allocates a free loopback port per
   * instance — without it every client falls back to the agent's fixed default
   * (25599) and two parallel in-process targets collide on the same port.
   */
  agentPort?: number;
  /** Test/seam hook: inject a process spawner returning a live MCTP url
   *  (default = real launch, acceptance-only). */
  spawn?: (launch: ClientLaunch) => Promise<SpawnedClient>;
}

/** Regex that learns the client agent port from its stdout readiness line. */
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

/**
 * One in-process driver instance launches one rendered client and exposes its
 * client-agent MCTP endpoint. Construct, `start()` to get the ws URL, then
 * `stop()` to tear the client down.
 */
export class InProcessDriver {
  private readonly opts: InProcessLaunchOptions;
  private spawned: SpawnedClient | null = null;
  private url = "";

  constructor(opts: InProcessLaunchOptions = {}) {
    this.opts = opts;
  }

  /**
   * Launch the client (offline, mods injected), learn its agent port, and return
   * the agent ws url. Uses `opts.spawn` when provided (unit tests); otherwise
   * performs the real launch (acceptance-only).
   */
  async start(): Promise<{ url: string }> {
    const display: DisplayChoice = selectDisplay({
      platform: process.platform,
      pref: this.opts.display,
    });
    // Allocate a per-instance MCTP port (unless one was pinned) so parallel
    // in-process targets never collide on the agent's fixed default. The client
    // binds this via MCTEST_AGENT_PORT; defaultSpawn re-scrapes the bound port.
    const agentPort = this.opts.agentPort ?? (await findFreePort());
    const spec: ClientLaunchSpec = {
      mc: this.opts.mc ?? DEFAULT_MC,
      loader: this.opts.loader ?? DEFAULT_LOADER,
      mods: this.opts.mods ?? [],
      clientAgentJar: this.opts.clientAgentJar,
      windowSize: this.opts.windowSize,
      agentPort,
      display,
    };
    const launch = buildClientLaunch(spec);

    const spawner = this.opts.spawn ?? defaultSpawn;
    this.spawned = await spawner(launch);
    this.url = this.spawned.url;
    return { url: this.url };
  }

  /** The MCTP endpoint URL (valid after `start`). */
  get endpoint(): string {
    return this.url;
  }

  /** Tear down the rendered client (and its agent). */
  async stop(): Promise<void> {
    if (this.spawned) {
      const spawned = this.spawned;
      this.spawned = null;
      await spawned.stop();
    }
  }
}

/**
 * The real spawner (acceptance-only): spawn the provisioned client, scrape
 * `MCTP listening on :PORT` from its stdout, and resolve to
 * `ws://127.0.0.1:PORT/mctp`. Not exercised in this environment's CI — it needs a
 * real rendered client + framebuffer. Unit tests inject `opts.spawn` instead.
 */
async function defaultSpawn(launch: ClientLaunch): Promise<SpawnedClient> {
  const { spawn } = await import("node:child_process");
  const child = spawn(launch.command, launch.args, {
    env: { ...process.env, ...launch.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const port = await new Promise<number>((resolve, reject) => {
    let buffer = "";
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString();
      const m = MCTP_LISTENING.exec(buffer);
      if (m) {
        child.stdout?.off("data", onData);
        resolve(Number(m[1]));
      }
    };
    child.stdout?.on("data", onData);
    child.once("error", reject);
    child.once("exit", (code) =>
      reject(new Error(`client exited before MCTP came up (code ${code ?? "?"})`)),
    );
  });

  return {
    url: `ws://127.0.0.1:${port}/mctp`,
    stop: () =>
      new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.kill();
      }),
  };
}
