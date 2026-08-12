/**
 * `$dimension` substitution — the one place a case's concrete values are woven
 * into authored YAML.
 *
 * Shared by matrix expansion (step parameters) and the `expect:` invariant DSL
 * (spec commandcenter/40-testing-loop.md §4), so a `$face` in a step and a
 * `$face` in an expectation can never resolve differently.
 */

/** Render a value for interpolation into a string (stable, YAML-ish). */
export function stringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/**
 * Replace `$name` tokens from `bindings`, deeply, in any JSON value.
 *
 * A string that is EXACTLY one token (`"$held"`) resolves to the bound value
 * itself — preserving `null`/numbers/objects — while a token inside a larger
 * string (`"chest + $face"`) interpolates its rendered form. An unbound token is
 * left verbatim rather than becoming "undefined": a typo must stay visible.
 */
export function substituteBindings(value: unknown, bindings: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    const exact = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(value);
    if (exact) return exact[1]! in bindings ? bindings[exact[1]!] : value;
    return value.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (token, name: string) =>
      name in bindings ? stringify(bindings[name]) : token,
    );
  }
  if (Array.isArray(value)) return value.map((entry) => substituteBindings(entry, bindings));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, substituteBindings(entry, bindings)]),
    );
  }
  return value;
}
