/**
 * F2 — native old-version preflight (the "treat `via` as only-when-needed" decision).
 *
 * The headless bot speaks its advertised `mcVersionRange` NATIVELY (Mineflayer +
 * minecraft-data span ~1.8–1.21), so an in-range target — including legacy versions like
 * `1.8.9` — connects DIRECTLY with no proxy. `via` is therefore advisory: it only changes
 * behavior when a target's `mc` is OUTSIDE the native range, which genuinely needs ViaProxy
 * protocol bridging (a deferred v2 follow-on) and so honest-skips `VIA_BRIDGE_UNAVAILABLE`.
 *
 * This lives in its own pure module (no side effects, no CLI execution) so the decision is
 * unit-testable in isolation.
 */
import { mcVersionRangesIntersect } from "@mc-test/protocol";
import { HEADLESS_CAPABILITIES } from "@mc-test/driver-headless";
import type { MatrixTarget } from "../model/Target.js";

/** The headless bot's native (no-proxy) version reach — its advertised `mcVersionRange`. */
export const HEADLESS_NATIVE_MC_RANGE: string =
  (HEADLESS_CAPABILITIES.mcVersionRange as string | undefined) ?? "*";

/**
 * Does `target` need ViaProxy bridging this build doesn't have? True ONLY when `via: true`
 * AND its `mc` is outside the bot's native range — that genuine case honest-skips
 * `VIA_BRIDGE_UNAVAILABLE`. Everything in-range (incl. legacy like 1.8.9) connects directly
 * with no proxy, so this returns false and the target runs. An out-of-range target WITHOUT
 * `via` returns false here and is left to capability negotiation (`NO_COMPATIBLE_DRIVER`).
 */
export function needsDeferredViaBridge(target: Pick<MatrixTarget, "via" | "mc">): boolean {
  return !!target.via && !mcVersionRangesIntersect(target.mc, HEADLESS_NATIVE_MC_RANGE);
}
