/**
 * Capability matching — a thin layer over `@mc-test/protocol`'s pure
 * `matchCapabilities`, plus helpers to convert between the object model and the
 * wire's string-array form.
 */
import {
  matchCapabilities,
  CAPABILITY_KEYS,
  type Capabilities,
  type CapabilityKey,
  type RequiredCapabilities,
} from "@mc-test/protocol";
import type { StepCapReq } from "./StepExecutor.js";

export { matchCapabilities };
export type { Capabilities, RequiredCapabilities, CapabilityKey };

/** The boolean capability keys set to `true` in a requirements object. */
export function requiredKeys(req: RequiredCapabilities): CapabilityKey[] {
  return CAPABILITY_KEYS.filter((k) => req[k] === true);
}

/** The boolean capability keys a driver advertises as `true`. */
export function advertisedKeys(caps: Capabilities): CapabilityKey[] {
  return CAPABILITY_KEYS.filter((k) => caps[k] === true);
}

/** Build a requirements object from a list of capability keys. */
export function capsFromKeys(keys: readonly string[]): RequiredCapabilities {
  const out: RequiredCapabilities = {};
  for (const k of keys) {
    if ((CAPABILITY_KEYS as readonly string[]).includes(k)) {
      out[k as CapabilityKey] = true;
    }
  }
  return out;
}

/**
 * Does `union` satisfy a step's combined requirement — its explicit `requires`
 * (ANDed) **and** the verb's capability requirement (a single key, or an anyOf
 * group where ANY member suffices)? The anyOf-aware companion of
 * `matchCapabilities` used for per-step honest skips (M4).
 *
 * - explicit part: every required key must be advertised (standard AND match).
 * - verbCap part: `null` → ok; a single key → the union must advertise it; an
 *   array → ok iff the union advertises **any** member, else the unmet token is
 *   the joined group (e.g. `"containerGui|clientScreens"`) so the skip reason
 *   names the whole anyOf choice.
 * - combine: ok iff both; `unmet` = the concatenation (deduped, order-stable).
 */
export function stepCapMatch(
  explicit: RequiredCapabilities,
  verbCap: StepCapReq,
  union: Capabilities,
): { ok: boolean; unmet: string[] } {
  const explicitMatch = matchCapabilities(explicit, union);
  const unmet: string[] = [...explicitMatch.unmet];

  if (verbCap !== null) {
    if (Array.isArray(verbCap)) {
      const anyAdvertised = verbCap.some((k) => matchCapabilities({ [k]: true }, union).ok);
      if (!anyAdvertised) unmet.push(verbCap.join("|"));
    } else {
      const single = matchCapabilities({ [verbCap as CapabilityKey]: true }, union);
      unmet.push(...single.unmet);
    }
  }

  // Dedupe while preserving first-seen order.
  const deduped = unmet.filter((k, i) => unmet.indexOf(k) === i);
  return { ok: deduped.length === 0, unmet: deduped };
}
