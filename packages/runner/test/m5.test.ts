/**
 * M5 "testing the tester" layer — the FAN-OUT proofs, all with NO Minecraft boot
 * (ROADMAP §6.3/§7.2/§7.3). One unchanged authored test runs across many
 * `(loader × version)` rows; the pixel/OCR driver is selectable ONLY as the
 * documented last resort (cost 4) and carries the advisory `brittle` flag + a loud
 * report note; the cross-target SKIP MATRIX shows which `(test × target)` cells
 * were skipped and why (machine-readable capability reason strings); and the
 * mappings-quarantine import-scan extends to the three new agent shims
 * (client-forge, client-neoforge, server-fabric).
 *
 * Like m3/m4, every "driver"/"agent" is a tiny live WebSocket mock spoken to
 * through the REAL `Runner` + `DriverRegistry` over real MCTP frames — the runner
 * never knows it isn't a real client/server. The new loader agents differ only in
 * their Java `Names.java` (invisible to the runner), so "fan-out across loaders"
 * is modeled as a list of target rows, exactly as a real matrix run would be.
 */
import { describe, it, expect, afterEach } from "vitest";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import {
  Runner,
  DriverRegistry,
  defaultRegistry,
  buildSkipMatrix,
  renderSkipMatrix,
  type AgentConn,
  type Capabilities,
  type DriverDescriptor,
  type NormalizedTest,
  type NormalizedStep,
  type TargetMeta,
  type TestResult,
  type ProvisionHandle,
} from "../src/index.js";
import { HEADLESS_CAPABILITIES } from "@mc-test/driver-headless/capabilities";
import { INPROCESS_CAPABILITIES } from "@mc-test/driver-inprocess/capabilities";
import { PIXEL_CAPABILITIES } from "@mc-test/driver-pixel/capabilities";
import { MockClientAgent, type MockClientAgentOptions } from "./mockClientAgent.js";
import { MockServerAgent, type MockServerAgentOptions } from "./mockServerAgent.js";

const SERVER_AGENT_CAPS: Capabilities = {
  worldTruth: true,
  pluginState: true,
  fixtures: true,
  fakePlayers: true,
  chat: true,
  testIdTags: true,
};

const EXEC = { host: "127.0.0.1", port: 25565, defaultUsername: "Tester" };

// --- live mock lifecycle (copied from m4) ----------------------------------
const clients: MockClientAgent[] = [];
const serverAgents: MockServerAgent[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((a) => a.stop()));
  await Promise.all(serverAgents.splice(0).map((a) => a.stop()));
});

async function startClient(opts?: MockClientAgentOptions): Promise<{ url: string; agent: MockClientAgent }> {
  const agent = new MockClientAgent(opts);
  clients.push(agent);
  const { url } = await agent.start();
  return { url, agent };
}
async function startServerAgent(opts?: MockServerAgentOptions): Promise<{ url: string; agent: MockServerAgent }> {
  const agent = new MockServerAgent(opts);
  serverAgents.push(agent);
  const { url } = await agent.start();
  return { url, agent };
}

/** A driver descriptor over a live mock url (or "" when it skips before create). */
function mockDescriptor(
  url: string,
  advertised: Capabilities,
  id: string,
  cost: number,
  kind: string,
): DriverDescriptor {
  return {
    id,
    kind,
    cost,
    advertised: { ...advertised },
    create: async () => ({ url, stop: async () => {} }),
  };
}

function agentConn(url: string): AgentConn {
  return { url, advertised: { ...SERVER_AGENT_CAPS }, kind: "serverMod" };
}

function stepByVerb(result: TestResult, verb: string) {
  return result.steps.find((s) => s.verb === verb);
}

/** The canonical client-GUI regions test — defined ONCE, reused across rows. */
function clientRegionsTest(extra: NormalizedStep[] = []): NormalizedTest {
  return {
    name: "regions-open-testregion",
    requires: { command: true, chat: true, clientScreens: true },
    steps: [
      { index: 0, verb: "join", args: { username: "Tester" } },
      { index: 1, verb: "command", args: "or" },
      { index: 2, verb: "waitForScreen", args: { titleContains: "Regions" } },
      { index: 3, verb: "click", args: { testId: "regions:root:regions" } },
      { index: 4, verb: "click", args: { testId: "regions:entry:TestRegion" } },
      { index: 5, verb: "assertChat", args: { contains: "Region loaded" } },
      {
        index: 6,
        verb: "assertPluginState",
        args: { plugin: "OpenRegions", query: "regions.exists", args: { name: "TestRegion" }, expect: true },
        requires: { pluginState: true },
      },
      ...extra.map((s, i) => ({ ...s, index: 7 + i })),
    ],
  };
}

/** Run one matrix row through the REAL `runTarget` orchestration (no boot). */
async function runRow(
  test: NormalizedTest,
  meta: TargetMeta,
  descriptor: DriverDescriptor,
  agents: AgentConn[],
): Promise<TestResult> {
  const registry = new DriverRegistry();
  registry.register(descriptor);
  const runner = new Runner(registry);
  const provision = async (): Promise<ProvisionHandle> => ({
    host: EXEC.host,
    port: EXEC.port,
    ...(agents.length ? { agents } : {}),
    stop: async () => {},
  });
  return runner.runTarget(test, meta, provision);
}

describe("M5 fan-out: one test across the (loader × version) matrix", () => {
  it("runs the SAME unchanged test green-or-honestly-skipped across paper/fabric/forge/neoforge", async () => {
    const test = clientRegionsTest();

    // Three live rendered-client mocks (fabric/forge/neoforge are the same
    // inprocess driver kind — they differ only in Java Names.java) + a server-mod
    // truth agent each so assertPluginState RUNS (not skips) on the client rows.
    const fabric = await startClient();
    const forge = await startClient();
    const neoforge = await startClient();
    const srvFabric = await startServerAgent({ seedRegions: ["TestRegion"] });
    const srvForge = await startServerAgent({ seedRegions: ["TestRegion"] });
    const srvNeo = await startServerAgent({ seedRegions: ["TestRegion"] });

    const inproc = (url: string) => mockDescriptor(url, INPROCESS_CAPABILITIES, "inprocess", 3, "clientMod");
    const headless = mockDescriptor("", HEADLESS_CAPABILITIES, "headless", 2, "headlessBot");

    const rows: { meta: TargetMeta; descriptor: DriverDescriptor; agents: AgentConn[] }[] = [
      // Headless bot rows — the client-GUI test CANNOT run here (no clientScreens).
      { meta: { target: "paper-1.20.4", loader: "paper", mc: "1.20.4", driverPin: "headless" }, descriptor: headless, agents: [] },
      { meta: { target: "paper-1.8.9", loader: "paper", mc: "1.8.9", driverPin: "headless" }, descriptor: headless, agents: [] },
      // Rendered-client rows — fabric / forge / neoforge all drive the real Screen.
      { meta: { target: "fabric-1.21-client", loader: "fabric", mc: "1.21.1", driverPin: "inprocess" }, descriptor: inproc(fabric.url), agents: [agentConn(srvFabric.url)] },
      { meta: { target: "forge-1.20.1-client", loader: "forge", mc: "1.20.1", driverPin: "inprocess" }, descriptor: inproc(forge.url), agents: [agentConn(srvForge.url)] },
      { meta: { target: "neoforge-1.21-client", loader: "neoforge", mc: "1.21.1", driverPin: "inprocess" }, descriptor: inproc(neoforge.url), agents: [agentConn(srvNeo.url)] },
    ];

    const results: TestResult[] = [];
    for (const row of rows) results.push(await runRow(test, row.meta, row.descriptor, row.agents));

    // Author-once: every row consumed the SAME object reference.
    // (the loop never mutated `test`).
    expect(results.map((r) => r.name)).toEqual(Array(5).fill("regions-open-testregion"));

    // Paper rows: honest WHOLE-TEST skip — the bot fundamentally cannot see a client Screen.
    for (const target of ["paper-1.20.4", "paper-1.8.9"]) {
      const r = results.find((x) => x.target === target)!;
      expect(r.outcome).toBe("skipped");
      expect(r.skip?.reason).toBe("NO_COMPATIBLE_DRIVER");
      expect(r.skip?.unmet).toEqual(["clientScreens"]);
    }

    // Client rows: GREEN including the server-truth assertPluginState (region really exists).
    for (const target of ["fabric-1.21-client", "forge-1.20.1-client", "neoforge-1.21-client"]) {
      const r = results.find((x) => x.target === target)!;
      expect(r.outcome, `${target} should be green`).toBe("passed");
      expect(stepByVerb(r, "assertPluginState")?.outcome).toBe("passed");
    }
  });
});

describe("M5 pixel/OCR driver: the universal last resort", () => {
  it("is registered in defaultRegistry at cost 4 (kind pixelOcr) advertising the advisory brittle flag", () => {
    const reg = defaultRegistry();
    const pixel = reg.list().find((d) => d.id === "pixel");
    expect(pixel, "defaultRegistry must register a pixel driver").toBeDefined();
    expect(pixel!.kind).toBe("pixelOcr");
    expect(pixel!.cost).toBe(4);
    expect(pixel!.advertised.brittle).toBe(true);
    // It is strictly costlier than every structural driver (last in cost order).
    for (const other of reg.list().filter((d) => d.id !== "pixel")) {
      expect(pixel!.cost).toBeGreaterThan(other.cost);
    }
  });

  it("is chosen ONLY when nothing structural fits (a clientScreens test still prefers inprocess)", () => {
    const runner = new Runner(defaultRegistry());
    // A plain clientScreens test → the cheaper inprocess wins; pixel is NOT chosen.
    expect(
      runner.selectDriver({ name: "cs", requires: { clientScreens: true }, steps: [] }).descriptor?.id,
    ).toBe("inprocess");
    // But a clientScreens test on a loader the structural client driver does NOT
    // support (inprocess advertises only fabric/quilt/forge/neoforge) → pixel is
    // the universal last resort (it advertises every loader).
    const vanilla = runner.selectDriver({
      name: "cs-vanilla",
      requires: { clientScreens: true, loader: "vanilla" },
      steps: [],
    });
    expect(vanilla.descriptor?.id).toBe("pixel");
  });

  it("negative control: registering inprocess ABOVE pixel keeps pixel unused for a normal clientScreens test", () => {
    // Cost order is the ONLY thing making pixel a last resort — prove it is not vacuous.
    const reg = new DriverRegistry();
    reg.register(mockDescriptor("", INPROCESS_CAPABILITIES, "inprocess", 3, "clientMod"));
    reg.register(mockDescriptor("", PIXEL_CAPABILITIES, "pixel", 4, "pixelOcr"));
    const runner = new Runner(reg);
    expect(runner.selectDriver({ name: "cs", requires: { clientScreens: true }, steps: [] }).descriptor?.id).toBe(
      "inprocess",
    );
    // Remove inprocess → only pixel remains → it IS the last resort.
    const pixelOnly = new DriverRegistry();
    pixelOnly.register(mockDescriptor("", PIXEL_CAPABILITIES, "pixel", 4, "pixelOcr"));
    expect(
      new Runner(pixelOnly).selectDriver({ name: "cs", requires: { clientScreens: true }, steps: [] }).descriptor?.id,
    ).toBe("pixel");
  });

  it("emits a LOUD brittle report note when the pixel driver actually runs a test", async () => {
    // A live client mock standing in for the (unimplemented) pixel backend, wrapped
    // in a brittle pixel descriptor, proves the runner surfaces the warning.
    const { url } = await startClient();
    const runner = new Runner(new DriverRegistry());
    const descriptor = mockDescriptor(url, PIXEL_CAPABILITIES, "pixel", 4, "pixelOcr");

    const result = await runner.runTest(
      clientRegionsTest(),
      descriptor,
      url,
      EXEC,
      { target: "pixel-row", loader: "vanilla", mc: "1.21.1" },
      [],
    );

    expect(result.brittle).toBe(true);
    expect(result.notes?.length).toBeGreaterThan(0);
    expect(result.notes!.join("\n")).toMatch(/BRITTLE DRIVER/);
    // The note is also folded into systemOut so it reaches the JUnit <system-out>.
    expect(result.systemOut).toMatch(/BRITTLE DRIVER/);
    // A non-brittle driver does NOT get the marker.
    const clean = await runner.runTest(
      clientRegionsTest(),
      mockDescriptor(url, INPROCESS_CAPABILITIES, "inprocess", 3, "clientMod"),
      url,
      EXEC,
      { target: "clean-row", loader: "fabric", mc: "1.21.1" },
      [],
    );
    expect(clean.brittle).toBeUndefined();
    expect(clean.notes).toBeUndefined();
  });
});

describe("M5 skip matrix: which (test × target) cells were skipped and why", () => {
  it("pivots results into a grid with machine-readable capability reasons", async () => {
    // A small matrix: one client-GUI test, two targets — one client row (green),
    // one headless row (whole-test skip), built via the real runner.
    const test = clientRegionsTest();
    const { url } = await startClient();
    const srv = await startServerAgent({ seedRegions: ["TestRegion"] });
    const green = await runRow(
      test,
      { target: "fabric-1.21-client", loader: "fabric", mc: "1.21.1", driverPin: "inprocess" },
      mockDescriptor(url, INPROCESS_CAPABILITIES, "inprocess", 3, "clientMod"),
      [agentConn(srv.url)],
    );
    const skipped = await runRow(
      test,
      { target: "paper-1.20.4", loader: "paper", mc: "1.20.4", driverPin: "headless" },
      mockDescriptor("", HEADLESS_CAPABILITIES, "headless", 2, "headlessBot"),
      [],
    );

    const matrix = buildSkipMatrix([green, skipped]);
    expect(matrix.tests).toEqual(["regions-open-testregion"]);
    expect(matrix.targets).toEqual(["fabric-1.21-client", "paper-1.20.4"]);

    const greenCell = matrix.get("regions-open-testregion", "fabric-1.21-client")!;
    expect(greenCell.outcome).toBe("passed");
    expect(greenCell.unmet).toEqual([]);

    const skipCell = matrix.get("regions-open-testregion", "paper-1.20.4")!;
    expect(skipCell.outcome).toBe("skipped");
    expect(skipCell.reasons).toContain("NO_COMPATIBLE_DRIVER");
    // The reason is a canonical, machine-readable capability key — not prose.
    expect(skipCell.unmet).toEqual(["clientScreens"]);

    // The rendered grid names every target/test and explains the skip.
    const rendered = renderSkipMatrix([green, skipped]);
    expect(rendered).toContain("paper-1.20.4");
    expect(rendered).toContain("fabric-1.21-client");
    expect(rendered).toContain("unmet:[clientScreens]");
  });

  it("flags a brittle-driver cell distinctly in the matrix", async () => {
    const { url } = await startClient();
    const runner = new Runner(new DriverRegistry());
    const brittleResult = await runner.runTest(
      clientRegionsTest(),
      mockDescriptor(url, PIXEL_CAPABILITIES, "pixel", 4, "pixelOcr"),
      url,
      EXEC,
      { target: "pixel-vanilla", loader: "vanilla", mc: "1.21.1" },
      [],
    );
    const cell = buildSkipMatrix([brittleResult]).get("regions-open-testregion", "pixel-vanilla")!;
    expect(cell.brittle).toBe(true);
    expect(renderSkipMatrix([brittleResult])).toMatch(/brittle-driver/);
  });

  it("keys cells unambiguously — distinct (test,target) pairs never collide", () => {
    // Two pairs whose naive `${test} ${target}` join would be identical ("a b c")
    // must remain DISTINCT cells (the lookup keys on JSON.stringify, not a space).
    const mk = (name: string, target: string, outcome: "passed" | "skipped"): TestResult => ({
      name,
      target,
      outcome,
      durationMs: 0,
      steps: [],
      ...(outcome === "skipped"
        ? { skip: { category: "capability" as const, reason: "NO_COMPATIBLE_DRIVER", unmet: ["clientScreens"], message: "" } }
        : {}),
    });
    const m = buildSkipMatrix([mk("a b", "c", "passed"), mk("a", "b c", "skipped")]);
    expect(m.cells.length).toBe(2);
    expect(m.get("a b", "c")?.outcome).toBe("passed");
    expect(m.get("a", "b c")?.outcome).toBe("skipped");
  });
});

describe("M5 mappings quarantine: mapped names ONLY in mappings/Names.java for the new shims", () => {
  // The CI import-scan (CLAUDE.md Prime Directive 2; ROADMAP §6.1/§8.1) extended to
  // the three M5 fan-out shims. Refinement vs m4's scan: the obfuscation-mapped
  // namespace is `net.minecraft.` *with the trailing dot* — so the stable loader
  // APIs `net.minecraftforge.*` (Forge), `net.neoforged.*` (NeoForge) and
  // `net.fabricmc.*` (Fabric) are correctly PERMITTED outside Names.java; only the
  // truly remapped `net.minecraft.*` (Yarn/MCP-SRG/Mojmap) symbols are quarantined.
  const MAPPED =
    /\b(?:net\.minecraft\.|net\.fabricmc\.yarn|org\.lwjgl\.glfw|com\.mojang\.(?:blaze3d|authlib|serialization|datafixers))/;

  for (const shim of ["client-forge", "client-neoforge", "server-fabric"]) {
    it(`${shim}: no mapped (net.minecraft.*) import outside mappings/Names.java`, () => {
      const root = fileURLToPath(new URL(`../../../agents/${shim}/src`, import.meta.url));
      if (!existsSync(root)) return; // tolerate a not-yet-landed shim (parallel build order)

      const javaFiles: string[] = [];
      const walk = (dir: string): void => {
        for (const name of readdirSync(dir)) {
          const full = join(dir, name);
          if (statSync(full).isDirectory()) walk(full);
          else if (name.endsWith(".java")) javaFiles.push(full);
        }
      };
      walk(root);
      expect(javaFiles.length, `${shim} should have Java sources`).toBeGreaterThan(0);

      // Non-vacuous: the quarantined file MUST itself contain mapped symbols.
      const namesPath = javaFiles.find((f) => f.replace(/\\/g, "/").endsWith("/mappings/Names.java"));
      expect(namesPath, `${shim} expected .../mappings/Names.java`).toBeDefined();
      expect(MAPPED.test(readFileSync(namesPath!, "utf8"))).toBe(true);

      const leaks: string[] = [];
      for (const file of javaFiles) {
        if (file === namesPath) continue;
        if (MAPPED.test(readFileSync(file, "utf8"))) leaks.push(relative(root, file).replace(/\\/g, "/"));
      }
      expect(leaks, `mapped symbols leaked outside Names.java in ${shim}: ${leaks.join(", ")}`).toEqual([]);
    });
  }
});
