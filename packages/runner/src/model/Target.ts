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
  server?: Source;
  plugins?: Source[];
  world?: WorldDef | { ref: string };
  serverProps?: Record<string, string | number | boolean>;
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
