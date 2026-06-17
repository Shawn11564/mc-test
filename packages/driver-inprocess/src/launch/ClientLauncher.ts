/**
 * Pure construction of the offline rendered-client launch (no Microsoft auth).
 *
 * `buildClientLaunch` is PURE: given an already-provisioned client (the resolved
 * classpath, natives dir, main class, game/assets dirs — produced by
 * `ClientProvisioner`) it returns the real `{ command, args, env }` that
 * `InProcessDriver` spawns. This is a genuine `java -cp … net.fabricmc.loader.
 * impl.launch.knot.KnotClient …` invocation — NOT a fictional launcher CLI.
 *
 * Offline discipline (ROADMAP §8.3): NO Microsoft/Mojang auth. The client joins
 * an `online-mode=false` server with a deterministic username, a zero UUID, and
 * a zero access token — never a real session token.
 */
import type { DisplayChoice } from "./Display.js";
import { substituteArgs } from "./loaders.js";

/**
 * A loader's *modular* launch profile (Forge/NeoForge): the JVM + game args from
 * the installer-produced launcher profile, already substituted for path/version
 * placeholders but still carrying the identity placeholders (`${auth_player_name}`
 * …) for the launcher to fill from the offline identity. Present only for modular
 * loaders; absent for Fabric (which uses the simple KnotClient game args below).
 */
export interface LaunchProfile {
  jvmArgs: string[];
  gameArgs: string[];
}

/** A fully provisioned, launchable client (output of `ClientProvisioner`). */
export interface ResolvedClient {
  /** Minecraft version, e.g. `"1.21.1"`. */
  mc: string;
  /** Loader id, e.g. `"fabric"`. */
  loader: string;
  /** Resolved loader version, e.g. `"0.16.5"`. */
  loaderVersion: string;
  /** Absolute path to the `java` executable to launch with. */
  javaPath: string;
  /** Launch main class (Fabric: `net.fabricmc.loader.impl.launch.knot.KnotClient`). */
  mainClass: string;
  /** Absolute classpath entries (vanilla client jar + vanilla + loader libraries). */
  classpath: string[];
  /** Directory the extracted LWJGL natives live in (`-Djava.library.path`). */
  nativesDir: string;
  /** The per-instance game directory (holds `mods/`, saves, logs). */
  gameDir: string;
  /** The shared assets root (`assets/indexes`, `assets/objects`). */
  assetsDir: string;
  /** The asset index id, e.g. `"17"`. */
  assetIndex: string;
  /** The platform the client runs on (drives classpath separator + mac flags). */
  platform: NodeJS.Platform;
  /**
   * Modular loaders only (Forge/NeoForge): the installer-derived JVM + game args.
   * When present, the launch uses these instead of the hardcoded Fabric game args
   * (and skips the Fabric-only `-DFabricMcEmu`). Absent → the Fabric KnotClient path.
   */
  launchProfile?: LaunchProfile;
}

/** Offline identity overrides (deterministic — never a real auth identity). */
export interface OfflineIdentity {
  username?: string;
  uuid?: string;
}

/** Offline defaults — deterministic, never a real auth identity. */
const DEFAULT_USERNAME = "Tester";
/** The all-zero offline UUID (no Microsoft account). */
const DEFAULT_UUID = "00000000-0000-0000-0000-000000000000";
/** A sentinel access token: offline auth, never a session token. */
const OFFLINE_ACCESS_TOKEN = "0";
const DEFAULT_WINDOW_SIZE = "1280x720";

/** Everything needed to shape the launch invocation. */
export interface BuildLaunchInput {
  client: ResolvedClient;
  /** The resolved display choice (provides DISPLAY/LIBGL env on the Xvfb path). */
  display: DisplayChoice;
  /** Port the client agent should host MCTP on (passed via `MCTEST_AGENT_PORT`). */
  agentPort?: number;
  identity?: OfflineIdentity;
  /** `"WIDTHxHEIGHT"` window size (default `"1280x720"`). */
  windowSize?: string;
  /** Extra JVM args (e.g. `-Xmx`); inserted before `-cp`. */
  extraJvmArgs?: string[];
}

/**
 * Build the real offline client launch command. PURE — performs no I/O and
 * spawns nothing; it only shapes the `java` invocation from a `ResolvedClient`.
 * The classpath separator and mac `-XstartOnFirstThread` are chosen from
 * `client.platform`, so a launch can be shaped for any target host (testable
 * cross-platform). The agent port + display env are threaded through `env`.
 */
export function buildClientLaunch(input: BuildLaunchInput): {
  command: string;
  args: string[];
  env: Record<string, string>;
} {
  const { client, display } = input;
  const username = input.identity?.username ?? DEFAULT_USERNAME;
  const uuid = input.identity?.uuid ?? DEFAULT_UUID;
  const sep = client.platform === "win32" ? ";" : ":";

  const env: Record<string, string> = { ...display.env };
  if (input.agentPort !== undefined) {
    env["MCTEST_AGENT_PORT"] = String(input.agentPort);
  }

  // The offline identity placeholders the launcher fills (modular loaders carry
  // these in their profile args; never a Microsoft session token).
  const identity: Record<string, string> = {
    auth_player_name: username,
    auth_uuid: uuid,
    auth_access_token: OFFLINE_ACCESS_TOKEN,
    auth_session: OFFLINE_ACCESS_TOKEN,
    auth_xuid: "0",
    clientid: "0",
    user_type: "legacy",
    version_type: "release",
  };

  // MODULAR loaders (Forge/NeoForge): use the installer-derived JVM + game args
  // (BootstrapLauncher + module path). Identity placeholders are substituted here;
  // path/version placeholders were already substituted at provision time.
  if (client.launchProfile) {
    const jvm = [
      ...(client.platform === "darwin" ? ["-XstartOnFirstThread"] : []),
      `-Djava.library.path=${client.nativesDir}`,
      `-Dorg.lwjgl.librarypath=${client.nativesDir}`,
      ...(input.extraJvmArgs ?? []),
      ...substituteArgs(client.launchProfile.jvmArgs, identity),
    ];
    const game = substituteArgs(client.launchProfile.gameArgs, identity);
    return { command: client.javaPath, args: [...jvm, client.mainClass, ...game], env };
  }

  // FABRIC / Quilt: the simple KnotClient classpath launch (F3 path, unchanged).
  const [width, height] = (input.windowSize ?? DEFAULT_WINDOW_SIZE).split("x");
  const jvm: string[] = [
    // macOS needs the GL context created on the first thread.
    ...(client.platform === "darwin" ? ["-XstartOnFirstThread"] : []),
    `-Djava.library.path=${client.nativesDir}`,
    `-Dorg.lwjgl.librarypath=${client.nativesDir}`,
    // Tells Fabric loader which vanilla entrypoint it is emulating.
    "-DFabricMcEmu=net.minecraft.client.main.Main",
    ...(input.extraJvmArgs ?? []),
    "-cp",
    client.classpath.join(sep),
  ];

  // Offline game args only — no `--accessToken <session>` from Microsoft.
  const game: string[] = [
    "--username", username,
    "--version", client.mc,
    "--gameDir", client.gameDir,
    "--assetsDir", client.assetsDir,
    "--assetIndex", client.assetIndex,
    "--uuid", uuid,
    "--accessToken", OFFLINE_ACCESS_TOKEN,
    "--userType", "legacy",
    "--versionType", "release",
    "--width", width ?? "1280",
    "--height", height ?? "720",
  ];

  return { command: client.javaPath, args: [...jvm, client.mainClass, ...game], env };
}
