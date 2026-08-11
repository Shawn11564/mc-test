/**
 * YAML honesty (spec commandcenter/40-testing-loop.md §9 phase 1): a `mc-test.yml`
 * key the runner never reads must be caught at parse time, not silently accepted —
 * that "accepted but does nothing" gap is exactly how mc-test.example.yml drifted
 * ~60% fictional. `collectUnknownKeys` is the same walk `parseMatrix` warns from;
 * this test also pins the real, committed example/root matrix files to zero
 * warnings so a future field rename/removal is caught here instead of by a user.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { collectUnknownKeys, parseMatrix } from "../src/index.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

function parseYaml(path: string): unknown {
  return parse(readFileSync(path, "utf8"));
}

describe("collectUnknownKeys — real mc-test.yml files parse clean", () => {
  it("mc-test.example.yml has zero unknown keys", () => {
    expect(collectUnknownKeys(parseYaml(`${repoRoot}mc-test.example.yml`))).toEqual([]);
  });

  it("the CI-run root mc-test.yml has zero unknown keys", () => {
    expect(collectUnknownKeys(parseYaml(`${repoRoot}mc-test.yml`))).toEqual([]);
  });
});

describe("collectUnknownKeys — catches drift at every nesting level", () => {
  it("flags an unknown top-level key", () => {
    expect(collectUnknownKeys({ version: 1, targets: [], suites: [] })).toContain("$.suites");
  });

  it("flags an unknown provision key", () => {
    const doc = { version: 1, targets: [], provision: { eulaAccepted: true, retries: 3 } };
    expect(collectUnknownKeys(doc)).toContain("$.provision.retries");
  });

  it("flags a dead Source field (ref/mojang) on a plugin entry", () => {
    const doc = {
      version: 1,
      targets: [{ id: "t", loader: "paper", mc: "1.20.4", plugins: [{ ref: "regions-plugin" }] }],
    };
    expect(collectUnknownKeys(doc)).toContain("$.targets[0].plugins[0].ref");
  });

  it("flags an unknown key inside a nested paper/modrinth ref", () => {
    const doc = {
      version: 1,
      targets: [
        {
          id: "t",
          loader: "paper",
          mc: "1.20.4",
          server: { paper: { build: "latest", channel: "experimental" } },
          mods: [{ modrinth: { project: "x", pin: true } }],
        },
      ],
    };
    const warnings = collectUnknownKeys(doc);
    expect(warnings).toContain("$.targets[0].server.paper.channel");
    expect(warnings).toContain("$.targets[0].mods[0].modrinth.pin");
  });

  it("accepts world: { ref } but flags a stray key alongside it", () => {
    const doc = {
      version: 1,
      targets: [{ id: "t", loader: "paper", mc: "1.20.4", world: { ref: "w", levelName: "world" } }],
    };
    expect(collectUnknownKeys(doc)).toContain("$.targets[0].world.levelName");
  });

  it("accepts every real field with no warnings", () => {
    const doc = {
      version: 1,
      provision: { eulaAccepted: true, bindHost: "127.0.0.1", downloadJdks: true },
      worlds: { w: { snapshot: { path: "./world" }, levelName: "world" } },
      targets: [
        {
          id: "t",
          loader: "fabric",
          mc: "1.21.1",
          loaderVersion: "0.19.3",
          driver: "server",
          server: { paper: { build: "latest" } },
          plugins: [{ path: "./x.jar", sha256: "a".repeat(64), as: "x.jar" }],
          mods: [{ modrinth: { project: "ferrite-core", version: "sOzRw3CG" }, as: "y.jar" }],
          agents: ["server-fabric"],
          expectMods: ["ferritecore"],
          world: { ref: "w" },
          serverProps: { "view-distance": 6 },
          ops: ["bot"],
          timeoutSec: 300,
        },
      ],
    };
    expect(collectUnknownKeys(doc)).toEqual([]);
  });
});

describe("parseMatrix — warns via console.warn, never throws, for an unknown key", () => {
  it("logs one warning per unknown key and still returns the parsed matrix", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const doc = { version: 1, targets: [{ id: "t", loader: "paper", mc: "1.20.4" }], reporting: {} };
    const matrix = parseMatrix(doc, "inline-doc");
    expect(matrix.targets).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("$.reporting");
    warn.mockRestore();
  });
});
