import { describe, it, expect } from "vitest";
import {
  matchCapabilities,
  compareMcVersions,
  mcVersionRangesIntersect,
  CAPABILITY_KEYS,
} from "../src/capabilities";

describe("matchCapabilities", () => {
  it("returns ok with empty unmet when all booleans are satisfied", () => {
    const r = matchCapabilities(
      { command: true, containerGui: true, chat: true },
      { command: true, containerGui: true, chat: true, typeText: true },
    );
    expect(r).toEqual({ ok: true, unmet: [] });
  });

  it("lists each unmet boolean capability", () => {
    const r = matchCapabilities(
      { command: true, clientScreens: true, screenshot: true },
      { command: true, containerGui: true },
    );
    expect(r.ok).toBe(false);
    expect(r.unmet).toEqual(["clientScreens", "screenshot"]);
  });

  it("treats a required:false as no requirement", () => {
    const r = matchCapabilities({ screenshot: false }, { command: true });
    expect(r).toEqual({ ok: true, unmet: [] });
  });

  it("an advertised capability that is not required does not matter", () => {
    const r = matchCapabilities({ command: true }, { command: true, fakePlayers: true });
    expect(r.ok).toBe(true);
  });

  it("matches loader by membership (single required vs advertised set)", () => {
    expect(matchCapabilities({ loader: "paper" }, { loader: ["paper", "spigot"] }).ok).toBe(true);
    expect(matchCapabilities({ loader: "fabric" }, { loader: "paper" }).unmet).toEqual(["loader"]);
  });

  it("matches loader when required is a set", () => {
    expect(matchCapabilities({ loader: ["fabric", "quilt"] }, { loader: "quilt" }).ok).toBe(true);
    expect(matchCapabilities({ loader: ["fabric", "quilt"] }, { loader: "paper" }).unmet).toEqual([
      "loader",
    ]);
  });

  it("matches mcVersionRange by intersection", () => {
    expect(matchCapabilities({ mcVersionRange: ">=1.16 <1.22" }, { mcVersionRange: "1.20.4" }).ok).toBe(
      true,
    );
    expect(matchCapabilities({ mcVersionRange: "1.8.9" }, { mcVersionRange: ">=1.16" }).unmet).toEqual([
      "mcVersionRange",
    ]);
  });

  it("an mcVersionRange requirement is unmet when the driver advertises none", () => {
    expect(matchCapabilities({ mcVersionRange: "1.20.4" }, {}).unmet).toEqual(["mcVersionRange"]);
  });

  it("aggregates boolean, loader, and version misses together", () => {
    const r = matchCapabilities(
      { pluginState: true, loader: "fabric", mcVersionRange: ">=1.21" },
      { command: true, loader: "paper", mcVersionRange: "1.20.4" },
    );
    expect(r.ok).toBe(false);
    expect(r.unmet).toEqual(["pluginState", "loader", "mcVersionRange"]);
  });

  it("is pure — does not mutate its inputs", () => {
    const required = { command: true } as const;
    const advertised = { command: true } as const;
    const before = JSON.stringify({ required, advertised });
    matchCapabilities(required, advertised);
    expect(JSON.stringify({ required, advertised })).toBe(before);
  });

  it("only knows the closed set of capability keys", () => {
    expect(CAPABILITY_KEYS).toContain("containerGui");
    expect(CAPABILITY_KEYS).not.toContain("loader"); // loader is a target descriptor, not a boolean cap
    expect(CAPABILITY_KEYS).not.toContain("brittle"); // brittle is an advisory quality descriptor, not a boolean cap
    expect(CAPABILITY_KEYS.length).toBe(13);
  });

  it("ignores the advisory `brittle` descriptor (it never participates in matching)", () => {
    // A driver advertising `brittle` still satisfies a normal requirement…
    expect(matchCapabilities({ clientScreens: true }, { clientScreens: true, brittle: true }).ok).toBe(true);
    // …and a test cannot "require" brittleness to force a brittle driver — it is a no-op in `required`.
    expect(matchCapabilities({ brittle: true } as never, { command: true })).toEqual({ ok: true, unmet: [] });
  });
});

describe("compareMcVersions", () => {
  it("orders versions numerically, segment by segment", () => {
    expect(compareMcVersions("1.20.4", "1.20.4")).toBe(0);
    expect(compareMcVersions("1.8.9", "1.16")).toBe(-1);
    expect(compareMcVersions("1.21", "1.20.4")).toBe(1);
    expect(compareMcVersions("1.20", "1.20.0")).toBe(0);
    expect(compareMcVersions("1.21.4", "1.21.10")).toBe(-1);
  });
});

describe("mcVersionRangesIntersect", () => {
  it("detects overlap and exact containment", () => {
    expect(mcVersionRangesIntersect("1.20.4", "1.20.4")).toBe(true);
    expect(mcVersionRangesIntersect(">=1.16 <1.22", "1.20.4")).toBe(true);
    expect(mcVersionRangesIntersect(">=1.8 <=1.21.4", ">=1.20")).toBe(true);
  });

  it("detects disjoint ranges", () => {
    expect(mcVersionRangesIntersect("1.8.9", ">=1.16")).toBe(false);
    expect(mcVersionRangesIntersect("<1.16", ">=1.16")).toBe(false);
    expect(mcVersionRangesIntersect(">=1.21", "<=1.20.4")).toBe(false);
  });

  it("treats wildcard / empty as unbounded", () => {
    expect(mcVersionRangesIntersect("*", "1.20.4")).toBe(true);
    expect(mcVersionRangesIntersect("", "1.8.9")).toBe(true);
    expect(mcVersionRangesIntersect("any", ">=1.21")).toBe(true);
  });
});
