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
