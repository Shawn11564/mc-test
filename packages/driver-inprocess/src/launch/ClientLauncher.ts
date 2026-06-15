/**
 * Pure construction of the offline rendered-client launch (no Microsoft auth).
 *
 * `buildClientLaunch` is PURE: it returns the `{ command, args, env }` that
 * `InProcessDriver` spawns. Real launching needs a *provisioned* client (a
 * Loom/launcher-built instance with the SUT mods + the client agent jar dropped
 * into its `mods/` dir) — that is acceptance-only and lives in the driver's real
 * `start()` path, not here.
 *
 * Offline discipline (ROADMAP §8.3): NO Microsoft/Mojang auth. The client joins
 * an `online-mode=false` server with a deterministic username, a zero UUID, and
 * a zero access token — never a real session token.
 */
import type { DisplayChoice } from "./Display.js";

/** Everything needed to build a rendered-client launch. */
export interface ClientLaunchSpec {
  /** Minecraft version, e.g. `"1.21.1"`. */
  mc: string;
  /** Loader, e.g. `"fabric"`. */
  loader: string;
  /** SUT mod jars to inject into the client's `mods/` dir. */
  mods: string[];
  /** The client MCTP agent jar (e.g. `agent-client-fabric.jar`). */
  clientAgentJar?: string;
  /** Offline username (default `"Tester"`). */
  username?: string;
  /** Offline UUID (default the zero form). */
  uuid?: string;
  /** `"WIDTHxHEIGHT"` window size (default `"1280x720"`). */
  windowSize?: string;
  /** Port the client agent should host MCTP on (passed via `MCTEST_AGENT_PORT`). */
  agentPort?: number;
  /** The resolved display choice (provides DISPLAY/LIBGL env on the Xvfb path). */
  display: DisplayChoice;
}

/** Offline defaults — deterministic, never a real auth identity. */
const DEFAULT_USERNAME = "Tester";
/** The all-zero offline UUID (no Microsoft account). */
const DEFAULT_UUID = "00000000-0000-0000-0000-000000000000";
const DEFAULT_WINDOW_SIZE = "1280x720";
/** A sentinel access token: offline auth, never a session token. */
const OFFLINE_ACCESS_TOKEN = "0";

/**
 * Build the offline client launch command. PURE — performs no I/O and spawns
 * nothing. The mods directory contents are the union of `mods` + `clientAgentJar`
 * (surfaced as `--mctest-mods` so the provisioner/launcher stages them), and the
 * client agent port + display env are threaded through `env`.
 *
 * NB: real launching requires a provisioned client (Loom/launcher); this only
 * shapes the invocation. The actual spawn + readiness scrape is acceptance-only
 * in `InProcessDriver.start()`.
 */
export function buildClientLaunch(spec: ClientLaunchSpec): {
  command: string;
  args: string[];
  env: Record<string, string>;
} {
  const username = spec.username ?? DEFAULT_USERNAME;
  const uuid = spec.uuid ?? DEFAULT_UUID;
  const windowSize = spec.windowSize ?? DEFAULT_WINDOW_SIZE;

  const mods = [...spec.mods, ...(spec.clientAgentJar ? [spec.clientAgentJar] : [])];

  const [width, height] = windowSize.split("x");

  // The client is launched via `java` against the provisioned instance. We pass
  // offline auth flags only — no `--accessToken <session>` from Microsoft.
  const args: string[] = [
    "--version",
    spec.mc,
    "--loader",
    spec.loader,
    "--username",
    username,
    "--uuid",
    uuid,
    "--accessToken",
    OFFLINE_ACCESS_TOKEN,
    "--width",
    width ?? "1280",
    "--height",
    height ?? "720",
  ];

  for (const mod of mods) {
    args.push("--mctest-mod", mod);
  }

  const env: Record<string, string> = {
    ...spec.display.env,
  };
  if (spec.agentPort !== undefined) {
    env["MCTEST_AGENT_PORT"] = String(spec.agentPort);
  }

  return { command: "java", args, env };
}
