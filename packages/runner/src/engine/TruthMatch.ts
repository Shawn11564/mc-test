/**
 * Pure matchers for the truth-assertion vocabulary: blockstate properties,
 * block-entity NBT, and **component-exact** item identity.
 *
 * All of this lives in the runner, never in an agent (Prime Directive 2): the
 * agent reports what it sees, the runner decides whether that satisfies the test.
 * Every matcher returns a human-readable mismatch string (or `null` for a match)
 * so a failure names the exact key, the expected value, and what was actually
 * there — a bare "assertion failed" is useless at 36 cases.
 */

/** A canonical, order-independent rendering of a JSON value (for messages + equality). */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Deep equality via canonical form — key order never affects the verdict. */
export function deepEqual(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/**
 * Scalar comparison used for blockstate properties: blockstate values arrive as
 * strings (`"east"`, `"8"`, `"false"`), so an author writing `facing: east` or
 * `waterlogged: false` compares stringly and case-insensitively.
 */
function scalarEq(expected: unknown, actual: unknown): boolean {
  return String(expected).trim().toLowerCase() === String(actual).trim().toLowerCase();
}

/**
 * Match an authored block-type expectation against the agent's authoritative
 * read. Ids are compared case-insensitively with the `minecraft:` namespace
 * OPTIONAL (`stone` == `minecraft:stone`; a modded `mymod:stone` still differs),
 * and `*`/`?` globs are honoured — which is what lets ONE invariant say
 * `is: "*_sign"` across every wood type rather than six per-case assertions.
 *
 * Used by both `getBlock` and `waitForBlock` (via `probeBlock`), so an assert-once
 * and an assert-until read can never judge the same block differently.
 */
export function matchBlockType(expected: string, actual: string | null | undefined): boolean {
  if (actual === null || actual === undefined) return false;
  const strip = (id: string): string => id.trim().toLowerCase().replace(/^minecraft:/, "");
  const want = expected.trim().toLowerCase();
  const got = actual.trim().toLowerCase();
  if (/[*?]/.test(want)) {
    const pattern = new RegExp(
      `^${want.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`,
    );
    return pattern.test(got) || pattern.test(strip(got));
  }
  return strip(want) === strip(got);
}

/**
 * Subset-match blockstate properties. Every listed key must be present AND equal;
 * unlisted properties are ignored. Returns a mismatch description or `null`.
 */
export function matchProperties(
  expected: Record<string, unknown>,
  actual: Record<string, unknown> | undefined,
): string | null {
  const have = actual ?? {};
  const problems: string[] = [];
  for (const [key, want] of Object.entries(expected)) {
    if (!(key in have)) {
      const known = Object.keys(have);
      problems.push(
        `${key}: expected ${JSON.stringify(want)}, but the block has no such property` +
          (known.length ? ` (has: ${known.join(", ")})` : " (block has no properties)"),
      );
      continue;
    }
    if (!scalarEq(want, have[key])) {
      problems.push(`${key}: expected ${JSON.stringify(want)}, got ${JSON.stringify(have[key])}`);
    }
  }
  return problems.length ? problems.join("; ") : null;
}

/**
 * Subset-match a nested structure (block-entity NBT). Objects recurse key-by-key;
 * arrays must match element-for-element (an NBT list is ordered data, so a
 * "subset" of a list would silently accept the wrong sign line). Scalars compare
 * by value, with the same stringly leniency as properties so `1` matches `"1"`.
 */
export function matchSubset(expected: unknown, actual: unknown, path = ""): string | null {
  const at = path || "<root>";
  if (expected === null) {
    return actual === null ? null : `${at}: expected null, got ${canonicalJson(actual)}`;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return `${at}: expected an array, got ${canonicalJson(actual)}`;
    if (expected.length !== actual.length) {
      return `${at}: expected ${expected.length} element(s), got ${actual.length}`;
    }
    for (let i = 0; i < expected.length; i++) {
      const problem = matchSubset(expected[i], actual[i], `${path}[${i}]`);
      if (problem) return problem;
    }
    return null;
  }
  if (typeof expected === "object") {
    if (actual === null || actual === undefined || typeof actual !== "object" || Array.isArray(actual)) {
      return `${at}: expected an object, got ${canonicalJson(actual)}`;
    }
    const have = actual as Record<string, unknown>;
    for (const [key, want] of Object.entries(expected as Record<string, unknown>)) {
      if (!(key in have)) {
        return `${path ? `${path}.` : ""}${key}: missing (present: ${Object.keys(have).join(", ") || "nothing"})`;
      }
      const problem = matchSubset(want, have[key], path ? `${path}.${key}` : key);
      if (problem) return problem;
    }
    return null;
  }
  return scalarEq(expected, actual)
    ? null
    : `${at}: expected ${JSON.stringify(expected)}, got ${canonicalJson(actual)}`;
}

/** The item shape the truth methods return (the fields the matcher reads). */
export interface TruthItem {
  type?: string;
  count?: number;
  slot?: number;
  displayName?: string;
  components?: Record<string, unknown>;
  componentsHash?: string;
}

/** An authored item assertion (mirrors `ItemExpectation` in the authoring model). */
export interface ItemExpectation {
  type?: string;
  count?: number;
  displayName?: string;
  components?: Record<string, unknown>;
  componentsInclude?: Record<string, unknown>;
  componentsHash?: string;
  empty?: boolean;
}

/** Short human label for an item (used in mismatch messages). */
export function describeItem(item: TruthItem | null | undefined): string {
  if (!item) return "<empty>";
  const name = item.displayName ? ` "${item.displayName}"` : "";
  // Show a short digest prefix (algorithm label stripped) — enough to eyeball that two
  // slots hold genuinely different items in a report, without a wall of hex.
  const digest = item.componentsHash?.replace(/^[a-z0-9]+:/, "");
  const hash = digest ? ` #${digest.slice(0, 12)}` : "";
  return `${item.count ?? 1}× ${item.type ?? "?"}${name}${hash}`;
}

/**
 * Match one item against an expectation. `components` is compared **exactly**
 * (whole-map deep equality), which is the point of the vocabulary: a modded item
 * is a vanilla material plus components, so an exact comparison is the only thing
 * that makes "a Cobblemon item only equals itself" true. `componentsInclude` is
 * the deliberate looser escape hatch, and `componentsHash` the cheap digest form.
 *
 * An expectation that names components against an agent that reports none
 * (`components` absent) FAILS: absent means "the agent cannot see components",
 * and passing there would be a false green for every modded item.
 */
export function matchItem(expected: ItemExpectation, actual: TruthItem | null): string | null {
  if (expected.empty === true) {
    return actual === null ? null : `expected the slot to be empty, found ${describeItem(actual)}`;
  }
  if (actual === null) {
    return `expected ${expected.type ?? "an item"}, found an empty slot`;
  }
  const problems: string[] = [];
  if (expected.type !== undefined && !scalarEq(expected.type, actual.type ?? "")) {
    problems.push(`type: expected ${expected.type}, got ${actual.type ?? "?"}`);
  }
  if (expected.count !== undefined && expected.count !== actual.count) {
    problems.push(`count: expected ${expected.count}, got ${actual.count ?? "?"}`);
  }
  if (expected.displayName !== undefined && expected.displayName !== actual.displayName) {
    problems.push(
      `displayName: expected ${JSON.stringify(expected.displayName)}, got ${JSON.stringify(actual.displayName ?? null)}`,
    );
  }
  if (expected.componentsHash !== undefined) {
    if (actual.componentsHash === undefined) {
      problems.push("componentsHash: the agent reported no component digest for this item");
    } else if (expected.componentsHash !== actual.componentsHash) {
      problems.push(`componentsHash: expected ${expected.componentsHash}, got ${actual.componentsHash}`);
    }
  }
  if (expected.components !== undefined) {
    if (actual.components === undefined) {
      problems.push("components: the agent cannot see this item's components (none reported)");
    } else if (!deepEqual(expected.components, actual.components)) {
      // EXACT: report both sides, since "which extra component" is the usual cause.
      problems.push(
        `components: expected exactly ${canonicalJson(expected.components)}, got ${canonicalJson(actual.components)}`,
      );
    }
  }
  if (expected.componentsInclude !== undefined) {
    if (actual.components === undefined) {
      problems.push("componentsInclude: the agent cannot see this item's components (none reported)");
    } else {
      const problem = matchSubset(expected.componentsInclude, actual.components, "components");
      if (problem) problems.push(problem);
    }
  }
  return problems.length ? problems.join("; ") : null;
}
