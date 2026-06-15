/**
 * Driver-side selector resolution for the headless bot: maps a semantic
 * `Selector` onto inventory slots by display-name / lore / itemType / testId.
 *
 * Pure and unit-testable — no Mineflayer here. The runner wraps the *call* in
 * SelectorWaits (retry/poll); this function does the instantaneous match.
 */
import type { Selector, SelectorRole } from "@mc-test/protocol";
import { normalize } from "../normalize.js";

/** A container-slot element the resolver matches against. */
export interface ResolvedElement {
  slot: number;
  elementId: string;
  label?: string;
  testId?: string;
  itemType?: string;
  lore?: string[];
  role?: SelectorRole;
}

/** Normalize a Minecraft item id to `namespace:path` form for comparison. */
function normalizeItemType(id: string): string {
  const lower = id.trim().toLowerCase();
  return lower.includes(":") ? lower : `minecraft:${lower}`;
}

function loreMatches(lore: string[] | undefined, needle: string | string[]): boolean {
  const hay = normalize((lore ?? []).join("\n"));
  const needles = Array.isArray(needle) ? needle : [needle];
  return needles.every((n) => hay.includes(normalize(n)));
}

/** True iff the element satisfies every present predicate of the selector. */
export function matchesSelector(selector: Selector, el: ResolvedElement): boolean {
  if (selector.testId !== undefined && el.testId !== selector.testId) return false;
  if (selector.label !== undefined && normalize(el.label ?? "") !== normalize(selector.label)) {
    return false;
  }
  if (selector.text !== undefined && normalize(el.label ?? "") !== normalize(selector.text)) {
    return false;
  }
  if (
    selector.textContains !== undefined &&
    !normalize(el.label ?? "").includes(normalize(selector.textContains))
  ) {
    return false;
  }
  if (selector.loreContains !== undefined && !loreMatches(el.lore, selector.loreContains)) {
    return false;
  }
  if (
    selector.itemType !== undefined &&
    (el.itemType === undefined || normalizeItemType(el.itemType) !== normalizeItemType(selector.itemType))
  ) {
    return false;
  }
  if (selector.role !== undefined && el.role !== selector.role) return false;
  // `within` is not meaningfully scoped for a flat container window (M2); a
  // present `within` further constrains via its own predicates as a safety net.
  if (selector.within !== undefined && !matchesSelector(selector.within, el)) return false;
  return true;
}

/** Which selector key "primarily" matched, for the resolved audit trail. */
export function primaryVia(selector: Selector): string {
  for (const key of ["testId", "label", "text", "textContains", "loreContains", "itemType", "role"]) {
    if ((selector as Record<string, unknown>)[key] !== undefined) return key;
  }
  return "selector";
}

export interface ResolveOutcome {
  matches: ResolvedElement[];
}

/**
 * Resolve a selector against the current container elements. Applies all
 * predicates (AND), then the `index`/`nth` disambiguator (0-based; negative
 * indexes from the end).
 */
export function resolveSelector(selector: Selector, elements: ResolvedElement[]): ResolveOutcome {
  let matched = elements.filter((el) => matchesSelector(selector, el));
  const ordinal = selector.index ?? selector.nth;
  if (ordinal !== undefined) {
    const idx = ordinal < 0 ? matched.length + ordinal : ordinal;
    matched = idx >= 0 && idx < matched.length ? [matched[idx]!] : [];
  }
  return { matches: matched };
}
