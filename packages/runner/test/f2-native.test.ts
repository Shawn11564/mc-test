import { describe, it, expect } from "vitest";
import { needsDeferredViaBridge, HEADLESS_NATIVE_MC_RANGE } from "../src/engine/viaPreflight.js";

/**
 * F2 — native old-version support. The headless bot speaks ~1.8–1.21 natively (Mineflayer +
 * minecraft-data), so an in-range target connects DIRECTLY with no proxy; `via` only forces an
 * honest skip when the version is genuinely outside that range (would need ViaProxy, a deferred
 * v2 follow-on). This replaces the old blanket "via:true → always skip" gate.
 */
describe("F2 native old-version preflight (needsDeferredViaBridge)", () => {
  it("the headless native range spans legacy through modern", () => {
    // Sourced from the driver's advertised mcVersionRange (single source of truth).
    expect(HEADLESS_NATIVE_MC_RANGE).toContain("1.8");
  });

  it("an in-range legacy version (1.8.9) connects natively — NOT skipped, even with via:true", () => {
    expect(needsDeferredViaBridge({ via: true, mc: "1.8.9" })).toBe(false);
  });

  it("an in-range modern version is never via-skipped", () => {
    expect(needsDeferredViaBridge({ via: true, mc: "1.20.4" })).toBe(false);
    expect(needsDeferredViaBridge({ via: false, mc: "1.20.4" })).toBe(false);
  });

  it("via:true BELOW the native range honest-skips (genuinely needs ViaProxy, deferred)", () => {
    expect(needsDeferredViaBridge({ via: true, mc: "1.7.10" })).toBe(true);
  });

  it("without via, an out-of-range version is left to capability negotiation (no via skip here)", () => {
    expect(needsDeferredViaBridge({ via: false, mc: "1.7.10" })).toBe(false);
    expect(needsDeferredViaBridge({ mc: "1.7.10" })).toBe(false);
  });
});
