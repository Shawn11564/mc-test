/**
 * Capability vocabulary + the pure capability-matching function.
 *
 * Drivers **advertise** capabilities; tests **require** them; the runner picks
 * the cheapest compatible driver or **skips with a reason**. PROTOCOL.md is the
 * source of truth for the capability *keys*; this file owns the TypeScript
 * `Capabilities`/`RequiredCapabilities` object model and the pure
 * `matchCapabilities` used by the runner's driver selection.
 *
 * Note on representations: on the *wire*, `session.create` carries capability
 * keys as string arrays plus `constraints` (see `mctp.ts`). The object model
 * here (a flat map of booleans + `loader`/`mcVersionRange` descriptors) is the
 * runner-side model the matcher operates on (ROADMAP §2.4).
 */
import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";

/** The closed set of boolean capability keys (PROTOCOL.md §6.1 / §13). */
export const CAPABILITY_KEYS = [
  "chat",
  "command",
  "containerGui",
  "clientScreens",
  "screenshot",
  "rendering",
  "worldTruth",
  "pluginState",
  "fixtures",
  "fakePlayers",
  "typeText",
  "pressKey",
  "testIdTags",
] as const;

export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

/** Minecraft loaders a target may run (target descriptor, not a boolean cap). */
export const LOADERS = [
  "spigot",
  "paper",
  "folia",
  "fabric",
  "forge",
  "neoforge",
  "quilt",
  "vanilla",
] as const;

export type Loader = (typeof LOADERS)[number];

export const LoaderSchema = Type.Union(
  LOADERS.map((l) => Type.Literal(l)),
  { description: "Minecraft loader." },
);

/**
 * The capability set as a flat object model: optional boolean per capability key
 * plus the two target descriptors (`loader`, `mcVersionRange`). A driver's
 * advertised set and a test's required set share this shape.
 */
export const Capabilities = Type.Object(
  {
    chat: Type.Optional(Type.Boolean()),
    command: Type.Optional(Type.Boolean()),
    containerGui: Type.Optional(Type.Boolean()),
    clientScreens: Type.Optional(Type.Boolean()),
    screenshot: Type.Optional(Type.Boolean()),
    rendering: Type.Optional(Type.Boolean()),
    worldTruth: Type.Optional(Type.Boolean()),
    pluginState: Type.Optional(Type.Boolean()),
    fixtures: Type.Optional(Type.Boolean()),
    fakePlayers: Type.Optional(Type.Boolean()),
    typeText: Type.Optional(Type.Boolean()),
    pressKey: Type.Optional(Type.Boolean()),
    testIdTags: Type.Optional(Type.Boolean()),
    /** Target descriptor: one loader or a set of acceptable loaders. */
    loader: Type.Optional(Type.Union([LoaderSchema, Type.Array(LoaderSchema)])),
    /** Target descriptor: a semver-ish MC version range, e.g. `">=1.8 <=1.21.4"`. */
    mcVersionRange: Type.Optional(Type.String()),
  },
  { additionalProperties: false, description: "Flat capability map + target descriptors." },
);
export type Capabilities = Static<typeof Capabilities>;

/** A test's required capabilities — same shape; every field optional. */
export const RequiredCapabilities = Capabilities;
export type RequiredCapabilities = Capabilities;

/** Result of `matchCapabilities`: whether all requirements are met, and which are not. */
export interface CapabilityMatch {
  ok: boolean;
  /** Keys (capability keys and/or `loader`/`mcVersionRange`) that were not satisfied. */
  unmet: string[];
}

// ---------------------------------------------------------------------------
// Version-range helpers (pure; small semver-ish intersection over MC versions).
// ---------------------------------------------------------------------------

/** Compare two dotted version strings numerically. Returns -1 / 0 / 1. */
export function compareMcVersions(a: string, b: string): number {
  const pa = a.split(".");
  const pb = b.split(".");
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = Number.parseInt(pa[i] ?? "0", 10) || 0;
    const nb = Number.parseInt(pb[i] ?? "0", 10) || 0;
    if (na < nb) return -1;
    if (na > nb) return 1;
  }
  return 0;
}

interface Interval {
  lo: string | null; // null = unbounded below
  loIncl: boolean;
  hi: string | null; // null = unbounded above
  hiIncl: boolean;
}

const FULL: Interval = { lo: null, loIncl: true, hi: null, hiIncl: true };

/**
 * Parse a range string into a single interval. Supports comparators `>=`, `>`,
 * `<=`, `<`, `=` (space-ANDed), a bare exact version (`"1.20.4"`), and the
 * wildcards `"*"` / `"any"` (unbounded). Unknown tokens are ignored.
 */
function parseRange(range: string): Interval {
  const trimmed = range.trim();
  if (trimmed === "" || trimmed === "*" || trimmed.toLowerCase() === "any") return { ...FULL };
  const result: Interval = { ...FULL };
  const tokens = trimmed.split(/\s+/);
  for (const token of tokens) {
    const m = /^(>=|<=|>|<|=)?\s*v?(\d+(?:\.\d+)*)$/.exec(token);
    if (!m) continue;
    const op = m[1] ?? "=";
    const ver = m[2]!;
    switch (op) {
      case "=":
        result.lo = ver;
        result.loIncl = true;
        result.hi = ver;
        result.hiIncl = true;
        break;
      case ">=":
        if (result.lo === null || compareMcVersions(ver, result.lo) > 0) {
          result.lo = ver;
          result.loIncl = true;
        }
        break;
      case ">":
        if (result.lo === null || compareMcVersions(ver, result.lo) >= 0) {
          result.lo = ver;
          result.loIncl = false;
        }
        break;
      case "<=":
        if (result.hi === null || compareMcVersions(ver, result.hi) < 0) {
          result.hi = ver;
          result.hiIncl = true;
        }
        break;
      case "<":
        if (result.hi === null || compareMcVersions(ver, result.hi) <= 0) {
          result.hi = ver;
          result.hiIncl = false;
        }
        break;
    }
  }
  return result;
}

/** Whether two MC version ranges have any version in common. */
export function mcVersionRangesIntersect(a: string, b: string): boolean {
  const ia = parseRange(a);
  const ib = parseRange(b);

  // Lower bound = the greater of the two lows.
  let lo: string | null;
  let loIncl: boolean;
  if (ia.lo === null) {
    lo = ib.lo;
    loIncl = ib.loIncl;
  } else if (ib.lo === null) {
    lo = ia.lo;
    loIncl = ia.loIncl;
  } else {
    const c = compareMcVersions(ia.lo, ib.lo);
    if (c > 0) {
      lo = ia.lo;
      loIncl = ia.loIncl;
    } else if (c < 0) {
      lo = ib.lo;
      loIncl = ib.loIncl;
    } else {
      lo = ia.lo;
      loIncl = ia.loIncl && ib.loIncl;
    }
  }

  // Upper bound = the lesser of the two highs.
  let hi: string | null;
  let hiIncl: boolean;
  if (ia.hi === null) {
    hi = ib.hi;
    hiIncl = ib.hiIncl;
  } else if (ib.hi === null) {
    hi = ia.hi;
    hiIncl = ia.hiIncl;
  } else {
    const c = compareMcVersions(ia.hi, ib.hi);
    if (c < 0) {
      hi = ia.hi;
      hiIncl = ia.hiIncl;
    } else if (c > 0) {
      hi = ib.hi;
      hiIncl = ib.hiIncl;
    } else {
      hi = ia.hi;
      hiIncl = ia.hiIncl && ib.hiIncl;
    }
  }

  if (lo === null || hi === null) return true; // at least one side unbounded
  const cmp = compareMcVersions(lo, hi);
  if (cmp < 0) return true;
  if (cmp > 0) return false;
  return loIncl && hiIncl; // equal bounds intersect only if both inclusive
}

function toLoaderArray(loader: Loader | Loader[] | undefined): Loader[] {
  if (loader === undefined) return [];
  return Array.isArray(loader) ? loader : [loader];
}

/**
 * Pure capability match. For every boolean capability the test sets to `true`,
 * the advertised set must also be `true`. `loader` is matched by membership
 * (intersection of the required and advertised loader sets); `mcVersionRange`
 * is matched by range intersection. Returns `{ ok, unmet[] }` listing every
 * unsatisfied key — the runner turns a non-empty `unmet` into a
 * `NO_COMPATIBLE_DRIVER` skip.
 */
export function matchCapabilities(
  required: RequiredCapabilities,
  advertised: Capabilities,
): CapabilityMatch {
  const unmet: string[] = [];

  for (const key of CAPABILITY_KEYS) {
    if (required[key] === true && advertised[key] !== true) {
      unmet.push(key);
    }
  }

  if (required.loader !== undefined) {
    const want = toLoaderArray(required.loader);
    const have = toLoaderArray(advertised.loader);
    // Required loader(s) are satisfied iff the advertised set overlaps them.
    const overlap = want.some((w) => have.includes(w));
    if (!overlap) unmet.push("loader");
  }

  if (required.mcVersionRange !== undefined) {
    if (
      advertised.mcVersionRange === undefined ||
      !mcVersionRangesIntersect(required.mcVersionRange, advertised.mcVersionRange)
    ) {
      unmet.push("mcVersionRange");
    }
  }

  return { ok: unmet.length === 0, unmet };
}
