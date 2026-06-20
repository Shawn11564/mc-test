/**
 * The `mc-test.yml` matrix model (the M2 subset of docs/ENVIRONMENTS.md).
 *
 * Field names match ENVIRONMENTS.md. M2 supports a deliberately small slice:
 * a Paper server source, local plugin sources, a world snapshot, and the
 * `headless` driver. Full matrix expansion / resolvers are M3+.
 */
import type { Loader, DriverId } from "@mc-test/protocol";

/** A `paper:` source ref → PaperMC fill API. */
export interface PaperRef {
  project?: "paper" | "folia" | "velocity";
  version?: string;
  build?: number | "latest";
}

/** A `mojang:` source ref → Mojang version manifest. */
export interface MojangRef {
  version?: string;
  artifact?: "server" | "client";
}

/** A `spigot:` source ref → built from source with Spigot BuildTools (legacy plugin-capable jars). */
export interface SpigotRef {
  /**
   * The Spigot **BuildTools rev** to build; defaults to the target's `mc`. Note Spigot revs can
   * differ from MC versions (e.g. MC 1.8.9 → Spigot rev `1.8.8`); see hub.spigotmc.org/versions/.
   */
  version?: string;
}

/** A `modrinth:` source ref → resolved via the Modrinth API (F5). */
export interface ModrinthRef {
  /** Project slug or id, e.g. `"ferrite-core"`. */
  project: string;
  /** Pinned version id (RECOMMENDED — deterministic); else newest matching the filters. */
  version?: string;
  /** Loader filter when resolving by project (`fabric`/`forge`/`neoforge`/`quilt`). */
  loader?: string;
  /** Minecraft version filter when resolving by project, e.g. `"1.21.1"`. */
  gameVersion?: string;
}

/** How to obtain one artifact (exactly one resolver). */
export interface Source {
  ref?: string;
  path?: string;
  url?: string;
  paper?: PaperRef;
  mojang?: MojangRef;
  spigot?: SpigotRef;
  modrinth?: ModrinthRef;
  sha256?: string;
  as?: string;
}

/** A named/inline world snapshot. */
export interface WorldDef {
  snapshot?: Source;
  levelName?: string;
}

/** Global provisioning knobs (M2 subset). */
export interface ProvisionPolicy {
  eulaAccepted?: boolean;
  bindHost?: string;
  portRange?: [number, number];
  cacheDir?: string;
  workDir?: string;
  keepOnFailure?: boolean;
  /**
   * Retain EVERY per-run env dir under `workDir` (even on success), for inspection.
   * Off by default so `.mc-test/run/` does not grow; the CLI `--keep` flag overrides.
   * Independent of `keepOnFailure` (which retains only failed envs for triage).
   */
  keepWorkDir?: boolean;
  /**
   * Rapid-dev mode: reuse ONE stable env dir per target (`workDir/<target.id>`),
   * "reset" between runs (worlds/logs/plugins wiped, heavy `libraries`/`cache`/
   * `versions` kept) instead of creating a fresh pid-suffixed dir each run. Faster
   * iteration, bounded to one dir per target. The CLI `--reuse` flag overrides.
   * Intended for focused single-target iteration (a stable name is shared, so it is
   * not safe to run the same target concurrently under reuse).
   */
  reuse?: boolean;
  /**
   * Share the heavy regenerables (`libraries`/`cache`/`versions`/`.fabric`, ~130 MB) across
   * runs of the same server build via a per-build cache under `cacheDir/runtime/` (item D),
   * so a fresh env junctions them in instead of re-downloading at boot. Default `true`; the
   * CLI `--no-share` flag (or `false`) disables it. Applies to Paper/Spigot and Fabric/Quilt/
   * vanilla servers (download-at-boot); NOT Forge/NeoForge (their installer writes `libraries/`
   * before boot). Rendered-client content is already shared via `cacheDir/clients`.
   */
  shareRuntime?: boolean;
  /**
   * Explicit JDK homes keyed by Java major (e.g. `{ "8": "C:/jdk8", "17": "/opt/jdk17" }`), used to
   * boot servers whose MC version needs a different Java than the host (multi-JDK provisioning). A
   * target's `mc` maps to a required major; the host JDK is preferred when it fits the range.
   */
  jdks?: Record<string, string>;
  /**
   * Fetch a matching Eclipse Temurin JDK from Adoptium into the cache when none is configured or
   * installed for a target's required Java major. Default `true`; set `false` for fully offline runs.
   */
  downloadJdks?: boolean;
}

/** One matrix target (template). */
export interface MatrixTarget {
  id: string;
  loader: Loader;
  mc: string;
  /**
   * Pin the loader version for a rendered-client target (M4/F4 `driver: inprocess`).
   * Fabric/Quilt: the Fabric loader version (else newest stable for `mc`).
   * Forge/NeoForge: REQUIRED to run the modular installer launch (e.g. forge
   * `"47.2.0"`, neoforge `"21.1.66"`); threaded to the in-process driver.
   */
  loaderVersion?: string;
  /**
   * Loader installer source for a modded SERVER (F5). For Fabric a pre-built
   * `fabric-server-launch.jar` (`server: { url|path, sha256 }` is preferred); for
   * Forge/NeoForge an installer jar override (else resolved from maven by
   * `loaderVersion`). Usually omitted — the provisioner resolves it.
   */
  loaderInstaller?: Source;
  /** `auto` lets capability negotiation pick (ENVIRONMENTS.md §1.2). */
  driver?: DriverId | "auto";
  /**
   * Advisory hint that a target may need protocol bridging (ENVIRONMENTS.md; ROADMAP §8.4).
   * The headless bot speaks its advertised `mcVersionRange` NATIVELY (Mineflayer +
   * minecraft-data span ~1.8–1.21), so an in-range target — including old versions like
   * `1.8.9` — connects DIRECTLY and needs no proxy; pair it with a plugin-capable
   * `server: { url|path, sha256 }` the PaperMC fill API cannot serve. `via: true` only
   * changes behavior when `mc` is OUTSIDE the native range: that genuinely needs ViaProxy
   * (a deferred v2 follow-on), so the cell honestly skips `VIA_BRIDGE_UNAVAILABLE` rather
   * than emitting a dubious pass.
   */
  via?: boolean;
  server?: Source;
  plugins?: Source[];
  /**
   * SUT mods to inject into a rendered client (M4 `driver: inprocess`). Each is a
   * source resolver (typically a `path:` to the built mod jar); the in-process
   * driver drops them into the launched client's `mods/` alongside the client
   * agent. Mirrors `plugins` for the mod/client-GUI form of a target.
   */
  mods?: Source[];
  /**
   * Display backend for a rendered client (M4 `driver: inprocess`): `xvfb` for
   * headless Linux CI (Mesa/llvmpipe), `desktop` for a native runner. Omitted →
   * the driver auto-selects by platform (`desktop` on win32/darwin, `xvfb` on
   * linux). ENVIRONMENTS.md `display ∈ {xvfb, desktop}`.
   */
  display?: "xvfb" | "desktop";
  /**
   * Co-selected server agents (M3): names of agents to provision alongside the
   * driver, e.g. `["server-bukkit"]`. Each is built, dropped into `plugins/`,
   * and given a second MCTP port; the runner connects them so truth/fixture/
   * player steps fan to the agent (honest skip when the list is empty).
   */
  agents?: string[];
  /** Optional per-agent source overrides (built-jar path), keyed by agent name. */
  agentSources?: Record<string, Source>;
  /**
   * Mod ids whose boot-log load to verify on a modded server (F5). The boot-log
   * scan is informational by default; listing ids here makes a MISSING one fail the
   * target (`MOD_NOT_LOADED`). The authoritative proof remains the MCTP `mod.loaded`
   * assertion in the test — this is a complementary, SUT-agnostic signal.
   */
  expectMods?: string[];
  world?: WorldDef | { ref: string };
  serverProps?: Record<string, string | number | boolean>;
  /**
   * Usernames granted operator on boot (written to `ops.json` with each name's
   * **offline** UUID, since servers run `online-mode=false`). The headless bot
   * runs commands AS the joined player, so a plugin command gated by a Bukkit
   * permission (e.g. ACF `@CommandPermission`) needs the bot op'd — list its
   * join username here. Omitted → no ops.json is written (M2 behavior).
   */
  ops?: string[];
  timeoutSec?: number;
  "online-mode"?: boolean;
}

/** The whole matrix file. */
export interface MatrixFile {
  version: number;
  provision?: ProvisionPolicy;
  worlds?: Record<string, WorldDef>;
  targets: MatrixTarget[];
}
