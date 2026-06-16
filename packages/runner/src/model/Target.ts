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

/** How to obtain one artifact (exactly one resolver). */
export interface Source {
  ref?: string;
  path?: string;
  url?: string;
  paper?: PaperRef;
  mojang?: MojangRef;
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
}

/** One matrix target (template). */
export interface MatrixTarget {
  id: string;
  loader: Loader;
  mc: string;
  /** `auto` lets capability negotiation pick (ENVIRONMENTS.md §1.2). */
  driver?: DriverId | "auto";
  /**
   * Route the headless driver through ViaVersion/ViaProxy so a modern Mineflayer
   * can speak to an old-version server (ENVIRONMENTS.md; ROADMAP §8.4). Used by
   * e.g. `paper-1.8.9`. The headless driver's wide `mcVersionRange` covers the old
   * version; the Via bridge itself is acceptance-only (provisioned in CI, not in
   * this offline build). If Via cannot faithfully bridge a feature, the driver
   * narrows its range and the cell honestly skips rather than producing a dubious
   * pass.
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
