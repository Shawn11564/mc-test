/**
 * Semantic selectors — the version-independent way a test names a UI element.
 *
 * The selector **shape** (the key set) is owned by this file and PROTOCOL.md
 * §7.3.1; the matching **semantics** (normalization, fuzzy matching, scoring,
 * disambiguation) are specified in SELECTORS.md and implemented in the
 * runner/drivers — never in this package and never inside an in-game agent.
 *
 * All present keys are AND-ed. At least one key MUST be present.
 */
import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";

/** The closed set of semantic roles a selector may target (PROTOCOL.md §7.3.1). */
export const SELECTOR_ROLES = [
  "button",
  "slot",
  "label",
  "input",
  "tab",
  "list",
  "listItem",
] as const;

export const SelectorRole = Type.Union(
  SELECTOR_ROLES.map((r) => Type.Literal(r)),
  { description: "Semantic widget role." },
);
export type SelectorRole = Static<typeof SelectorRole>;

/**
 * A semantic selector. All present keys are AND-ed; `within` scopes the search
 * to the element(s) matched by a nested selector. `index`/`nth` disambiguate
 * among the survivors (0-based; aliases).
 */
export const Selector = Type.Recursive(
  (Self) =>
    Type.Object(
      {
        /** Exact visible display name / item display-name (after normalization). */
        label: Type.Optional(Type.String()),
        /** Exact visible text match. */
        text: Type.Optional(Type.String()),
        /** Substring match against visible text. */
        textContains: Type.Optional(Type.String()),
        /** Substring match within item lore / tooltip line(s). */
        loreContains: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
        /** Namespaced item id (e.g. `minecraft:diamond_sword`). */
        itemType: Type.Optional(Type.String()),
        /** Semantic role. */
        role: Type.Optional(SelectorRole),
        /** 0-based positional disambiguator among matches. */
        index: Type.Optional(Type.Integer()),
        /** Alias of `index` (kept for readability/WebDriver parity). */
        nth: Type.Optional(Type.Integer()),
        /** Scope: match only inside the element(s) matched by this sub-selector. */
        within: Type.Optional(Self),
        /** Invisible stable test id emitted by SUTs we control (most robust). */
        testId: Type.Optional(Type.String()),
      },
      {
        additionalProperties: false,
        minProperties: 1,
        description: "Semantic selector (all present keys AND-ed; >=1 key required).",
      },
    ),
  { $id: "Selector" },
);
export type Selector = Static<typeof Selector>;

/** Canonical key order for `describeSelector`, for stable report/skip strings. */
const DESCRIBE_ORDER = [
  "testId",
  "label",
  "text",
  "textContains",
  "loreContains",
  "itemType",
  "role",
  "within",
  "index",
  "nth",
] as const;

function quote(value: string): string {
  return `"${value}"`;
}

/**
 * Render a selector as a stable, human-readable one-line string for skip/error
 * messages and reports — e.g. `label="Regions" within(role=tab)` or
 * `text="Region" role=button within(testId="regions:list") nth=0`.
 *
 * Pure and deterministic: key order is fixed regardless of insertion order.
 */
export function describeSelector(selector: Selector): string {
  const parts: string[] = [];
  for (const key of DESCRIBE_ORDER) {
    const value = (selector as Record<string, unknown>)[key];
    if (value === undefined) continue;
    switch (key) {
      case "testId":
      case "label":
      case "text":
      case "textContains":
      case "itemType":
        parts.push(`${key}=${quote(String(value))}`);
        break;
      case "loreContains":
        if (Array.isArray(value)) {
          parts.push(`loreContains=[${value.map((v) => quote(String(v))).join(",")}]`);
        } else {
          parts.push(`loreContains=${quote(String(value))}`);
        }
        break;
      case "role":
        parts.push(`role=${String(value)}`);
        break;
      case "within":
        parts.push(`within(${describeSelector(value as Selector)})`);
        break;
      case "index":
      case "nth":
        parts.push(`${key}=${String(value)}`);
        break;
    }
  }
  return parts.length > 0 ? parts.join(" ") : "<empty selector>";
}
