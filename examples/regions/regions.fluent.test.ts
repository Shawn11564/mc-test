/**
 * The canonical regions test, authored in the fluent API — the same test as
 * `regions.mctest.yml`. This file asserts the two authoring surfaces compile to
 * the *identical* internal `NormalizedTest`, so they run identically through the
 * engine (the M2 "fluent produces an identical pass" guarantee). The live pass
 * itself is exercised by the runner E2E (mock agent) and the real `mc-test run`.
 */
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { test, loadSteps, type NormalizedTest } from "@mc-test/runner";

/** The regions test in fluent form (importable by the E2E to run live). */
export function regionsFluent(): NormalizedTest {
  return test("regions-open-testregion")
    .requires({ command: true, containerGui: true })
    .join({ host: "localhost", port: 25565, username: "Tester" })
    .command("or")
    .waitForScreen({ titleContains: "OpenRegions" })
    .click({ label: "Regions" })
    .click({ label: "Spawn" })
    .assertChat({ contains: "Region loaded: Spawn" })
    .assertPluginState({
      requires: { pluginState: true },
      plugin: "OpenRegions",
      query: "regions.active",
      expect: { equals: "Spawn" },
    })
    .click({ label: "Create" })
    .assertChat({ contains: "Region created: Sanctuary" })
    .assertPluginState({
      requires: { pluginState: true },
      plugin: "OpenRegions",
      query: "regions.exists",
      args: { name: "Sanctuary" },
      expect: true,
    })
    .assertPluginState({
      requires: { pluginState: true },
      plugin: "OpenRegions",
      query: "regions.count",
      expect: { equals: 4 },
    })
    .build();
}

const yamlPath = fileURLToPath(new URL("./regions.mctest.yml", import.meta.url));

describe("regions: fluent API ≡ YAML", () => {
  it("compiles to the same NormalizedTest as the YAML step file", () => {
    const fromFluent = regionsFluent();
    const fromYaml = loadSteps(yamlPath);
    expect(fromFluent).toEqual(fromYaml);
  });
});
