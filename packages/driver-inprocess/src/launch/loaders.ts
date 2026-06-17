/**
 * Loader-aware launch resolution (F4 / ROADMAP §6.3 — multi-loader fan-out). The
 * in-process driver launches a rendered client for several loaders:
 *
 *   - **Fabric / Quilt** — a simple classpath launch: the Fabric loader profile
 *     gives `mainClass` (`KnotClient`) + maven-coord libraries; the client runs as
 *     `java -cp <vanilla + loader libs> KnotClient <offline game args>`. This is the
 *     F3 path (fully implemented + run; see `ClientProvisioner`/`ClientLauncher`).
 *
 *   - **Forge / NeoForge** — a *modular* launch: the loader **installer** (a Java
 *     program) downloads the loader libraries, runs processors to patch the client,
 *     and writes a launcher *profile* (a vanilla-style version JSON that
 *     `inheritsFrom` the vanilla version, with `arguments.jvm`/`arguments.game`
 *     templates + a `cpw.mods.bootstraplauncher.BootstrapLauncher` main class). The
 *     launch is `java <substituted jvm args> -cp <all libs> BootstrapLauncher
 *     <substituted game args>`.
 *
 * This module holds the **pure, unit-tested** core of the modular launch: maven
 * installer-coordinate resolution, the `${…}` argument-template substitution, the
 * OS-rule argument flattening, and merging a loader profile onto the vanilla
 * version. The genuinely **CI-gated** part — actually *running* the loader installer
 * on a GL-capable host — is a thin injectable seam in `ClientProvisioner`; on a host
 * that has not opted in (no `MC_TEST_RENDERED_LOADERS`) the forge/neoforge path
 * **honest-skips** (`UNSUPPORTED_TARGET`) rather than crashing or faking a green.
 * The Forge/NeoForge live boot is therefore the F4 analogue of F3's CI-gated Fabric
 * rendered-green: implemented + the pure parts verified offline, the live launch
 * gated to a capable runner.
 */
import {
  parseMaven,
  mavenPath,
  mavenUrl,
  ruleAllows,
  type ResolvedArtifact,
  type VersionJson,
  type MojangOs,
} from "./resolve.js";

/** The loaders the in-process driver can drive. */
export type LoaderId = "fabric" | "quilt" | "forge" | "neoforge";

/** Loaders that need the *modular* installer-based launch (Forge family). */
export const MODULAR_LOADERS: readonly LoaderId[] = ["forge", "neoforge"];

/** Loaders that use the simple Fabric classpath launch (KnotClient). */
export const FABRIC_LIKE_LOADERS: readonly LoaderId[] = ["fabric", "quilt"];

export function isModularLoader(loader: string): boolean {
  return (MODULAR_LOADERS as readonly string[]).includes(loader);
}
export function isFabricLike(loader: string): boolean {
  return (FABRIC_LIKE_LOADERS as readonly string[]).includes(loader);
}

/** Loader maven repositories (installer + libraries the installer can't fetch). */
export const FORGE_MAVEN = "https://maven.minecraftforge.net/";
export const NEOFORGE_MAVEN = "https://maven.neoforged.net/releases/";

/**
 * Resolve the loader **installer** jar to download + run. Forge versions are
 * `<mc>-<forge>` (e.g. `1.20.1-47.2.0`); NeoForge versions stand alone
 * (e.g. `21.1.66`). Pure: a maven coordinate → a downloadable artifact.
 */
export function loaderInstallerArtifact(
  loader: "forge" | "neoforge",
  mc: string,
  loaderVersion: string,
): ResolvedArtifact {
  if (loader === "forge") {
    const coord = parseMaven(`net.minecraftforge:forge:${mc}-${loaderVersion}:installer`);
    return { path: mavenPath(coord), url: mavenUrl(FORGE_MAVEN, coord) };
  }
  const coord = parseMaven(`net.neoforged:neoforge:${loaderVersion}:installer`);
  return { path: mavenPath(coord), url: mavenUrl(NEOFORGE_MAVEN, coord) };
}

// ---- launcher-profile argument handling (pure) ----------------------------

/** A single launch-argument entry: a literal, or an OS/feature-gated value. */
export type ArgEntry =
  | string
  | {
      rules?: { action: "allow" | "disallow"; os?: { name?: string; arch?: string; version?: string }; features?: Record<string, boolean> }[];
      value: string | string[];
    };

/**
 * A loader launcher profile (the JSON the installer writes under
 * `versions/<id>/<id>.json`). A partial view — only the fields the launch reads.
 * Modern Forge/NeoForge use `arguments`; very old Forge used `minecraftArguments`.
 */
export interface LoaderProfileJson {
  id: string;
  inheritsFrom?: string;
  mainClass: string;
  libraries: VersionJson["libraries"];
  arguments?: { jvm?: ArgEntry[]; game?: ArgEntry[] };
  /** Legacy single-string game args (split on whitespace). */
  minecraftArguments?: string;
}

/**
 * Flatten an `arguments.jvm`/`arguments.game` list for the current OS: literals
 * pass through; rule-gated entries are kept only when their OS rules allow and they
 * are NOT feature-gated (we never pass demo/quickPlay/custom-resolution features),
 * which `ruleAllows` already encodes (a feature-only rule never matches). Pure.
 */
export function flattenArguments(entries: ArgEntry[] | undefined, os: MojangOs): string[] {
  const out: string[] = [];
  for (const e of entries ?? []) {
    if (typeof e === "string") {
      out.push(e);
      continue;
    }
    if (!ruleAllows(e.rules, os)) continue;
    if (Array.isArray(e.value)) out.push(...e.value);
    else out.push(e.value);
  }
  return out;
}

/**
 * Substitute `${key}` placeholders in launch args from `vars`. Unknown
 * placeholders are left intact (so a missing var is visible in the launch rather
 * than silently blanked). Pure.
 */
export function substituteArgs(args: string[], vars: Record<string, string>): string[] {
  return args.map((a) => a.replace(/\$\{([^}]+)\}/g, (whole, key: string) => (key in vars ? vars[key]! : whole)));
}

/** The merged launch shape a loader profile + the vanilla version produce. */
export interface MergedLaunch {
  mainClass: string;
  /** Loader libraries FIRST (they override vanilla), then vanilla libraries. */
  libraries: VersionJson["libraries"];
  /** Raw (un-substituted) JVM args: vanilla then loader. */
  jvm: ArgEntry[];
  /** Raw (un-substituted) game args: vanilla then loader. */
  game: ArgEntry[];
}

/**
 * Merge a loader profile onto its inherited vanilla version (Forge/NeoForge):
 * loader libraries are prepended (they win), arguments are concatenated
 * (vanilla then loader), and the main class is the loader's. Handles a vanilla
 * version that uses modern `arguments` AND a profile that uses legacy
 * `minecraftArguments`. Pure — no I/O.
 */
export function mergeLaunchProfile(vanilla: VersionJson, loader: LoaderProfileJson): MergedLaunch {
  const vanillaArgs = (vanilla as { arguments?: { jvm?: ArgEntry[]; game?: ArgEntry[] } }).arguments;
  const legacyGame = (s: string | undefined): ArgEntry[] => (s ? s.split(/\s+/).filter(Boolean) : []);
  return {
    mainClass: loader.mainClass,
    libraries: [...loader.libraries, ...vanilla.libraries],
    jvm: [...(vanillaArgs?.jvm ?? []), ...(loader.arguments?.jvm ?? [])],
    game: [
      ...(vanillaArgs?.game ?? legacyGame((vanilla as { minecraftArguments?: string }).minecraftArguments)),
      ...(loader.arguments?.game ?? legacyGame(loader.minecraftArguments)),
    ],
  };
}

/** Inputs for the path/version placeholder substitution (everything but identity). */
export interface LaunchVarInputs {
  librariesDir: string;
  classpathSeparator: string;
  /** The launcher-profile id (Forge/NeoForge version_name, e.g. `1.20.1-forge-47.2.0`). */
  versionName: string;
  nativesDir: string;
  gameDir: string;
  assetsDir: string;
  assetIndex: string;
  /** The full classpath, already joined with the separator (`${classpath}`). */
  classpath: string;
}

/**
 * The non-identity `${…}` substitution map (paths/version/classpath). Identity
 * placeholders (`${auth_player_name}` / `${auth_uuid}` / `${auth_access_token}` /
 * `${user_type}` / `${version_type}`) are left for the launcher to fill from the
 * offline identity, so this stays free of any auth concern. Pure.
 */
export function launchVars(i: LaunchVarInputs): Record<string, string> {
  return {
    library_directory: i.librariesDir,
    classpath_separator: i.classpathSeparator,
    version_name: i.versionName,
    natives_directory: i.nativesDir,
    game_directory: i.gameDir,
    assets_root: i.assetsDir,
    game_assets: i.assetsDir,
    assets_index_name: i.assetIndex,
    classpath: i.classpath,
    launcher_name: "mc-test",
    launcher_version: "1.0",
  };
}
