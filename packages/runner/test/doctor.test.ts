/**
 * Preflight (`mc-test doctor` / the pre-session gate in `mc-test run`).
 *
 * The contract under test is the acceptance bar: **doctor exits non-zero with a
 * clear message for each missing dependency**, and it only asks for what the
 * SELECTED targets actually need — a matrix with no rendered row must not demand
 * Xvfb/Docker, and a missing agent jar must stay an honest skip rather than a
 * blocking error. Every probe is faked, so these run with no JDK/Docker/disk.
 */
import { describe, it, expect } from "vitest";
import {
  deriveNeeds,
  runPreflight,
  formatReport,
  exitCode,
  blockingFailures,
  RENDERED_IMAGE,
  MIN_NODE_MAJOR,
  type EnvProbe,
  type DoctorReport,
} from "../src/doctor/Preflight.js";
import type { MatrixTarget } from "../src/model/Target.js";

/** A host where everything is present; each test breaks exactly one thing. */
function probe(over: Partial<EnvProbe> = {}): EnvProbe {
  return {
    platform: "linux",
    nodeVersion: `v${MIN_NODE_MAJOR}.11.0`,
    env: { DISPLAY: ":0" },
    fileExists: () => true,
    commandVersion: async () => "present",
    dockerImages: async () => [RENDERED_IMAGE],
    freeDiskBytes: () => 50 * 1024 ** 3,
    ...over,
  };
}

const paperTarget: MatrixTarget = {
  id: "paper-1.20.4",
  loader: "paper",
  mc: "1.20.4",
  driver: "headless",
  agents: ["server-bukkit"],
  server: { paper: { project: "paper", version: "1.20.4", build: "latest" } },
};

const renderedTarget: MatrixTarget = {
  id: "fabric-1.21-client",
  loader: "fabric",
  mc: "1.21.1",
  driver: "inprocess",
  display: "xvfb",
  agents: ["client-fabric", "server-bukkit"],
};

const moddedServerTarget: MatrixTarget = {
  id: "forge-server-1.20.1",
  loader: "forge",
  mc: "1.20.1",
  driver: "server",
  agents: ["server-forge"],
  mods: [{ modrinth: { project: "ferrite-core" } }],
};

/** Stand-in for the CLI's KNOWN_AGENTS/KNOWN_CLIENT_AGENTS lookup. */
const resolveJar = (t: MatrixTarget, name: string): { jarPath: string; kind: "server" | "client" } | null => {
  if (!/^(server|client)-/.test(name)) return null;
  return {
    jarPath: t.agentSources?.[name]?.path ?? `/repo/agents/${name}/build/libs/${name}.jar`,
    kind: name.startsWith("client-") ? "client" : "server",
  };
};

const run = (targets: MatrixTarget[], p: EnvProbe): Promise<DoctorReport> =>
  runPreflight({
    probe: p,
    needs: deriveNeeds(targets, resolveJar),
    targets,
    matrixPath: "/repo/mc-test.yml",
    workDir: "/repo/.mc-test/run",
  });

const byId = (r: DoctorReport, id: string) => r.checks.find((c) => c.id === id);

describe("deriveNeeds — needs come from the matrix, never hardcoded", () => {
  it("asks for nothing rendered when no target uses the in-process driver", () => {
    const needs = deriveNeeds([paperTarget], resolveJar);
    expect(needs.rendered).toEqual([]);
    expect(needs.moddedServer).toBe(false);
    expect(needs.agentJars.map((a) => a.name)).toEqual(["server-bukkit"]);
    expect(needs.network).toBe(true);
  });

  it("flags rendered targets with their effective display, and modded servers", () => {
    const needs = deriveNeeds([renderedTarget, moddedServerTarget], resolveJar);
    expect(needs.rendered).toEqual([{ id: "fabric-1.21-client", display: "xvfb" }]);
    expect(needs.moddedServer).toBe(true);
    expect(needs.agentJars.map((a) => a.name).sort()).toEqual(["client-fabric", "server-bukkit", "server-forge"]);
  });

  it("dedupes an agent named by several targets", () => {
    const needs = deriveNeeds([paperTarget, { ...paperTarget, id: "other" }], resolveJar);
    expect(needs.agentJars).toHaveLength(1);
  });

  it("honors a per-target agentSources override", () => {
    const needs = deriveNeeds(
      [{ ...paperTarget, agentSources: { "server-bukkit": { path: "/custom/agent.jar" } } }],
      resolveJar,
    );
    expect(needs.agentJars[0]?.jarPath).toBe("/custom/agent.jar");
  });
});

describe("each missing dependency → a failing check with a remedy + non-zero exit", () => {
  it("java missing → blocking fail", async () => {
    const r = await run([paperTarget], probe({ commandVersion: async (c) => (c === "java" ? null : "present") }));
    const java = byId(r, "java")!;
    expect(java.status).toBe("fail");
    expect(java.blocking).toBe(true);
    expect(java.remedy).toMatch(/JDK/);
    expect(exitCode(r)).toBe(1);
    expect(blockingFailures(r).map((c) => c.id)).toContain("java");
  });

  it("a full disk → blocking fail with a clean-up remedy", async () => {
    const r = await run([paperTarget], probe({ freeDiskBytes: () => 1 * 1024 ** 3 }));
    const disk = byId(r, "disk")!;
    expect(disk.status).toBe("fail");
    expect(disk.blocking).toBe(true);
    expect(disk.remedy).toMatch(/mc-test clean/);
    expect(exitCode(r)).toBe(1);
  });

  it("an unparseable matrix → blocking fail", async () => {
    const r = await runPreflight({
      probe: probe(),
      needs: deriveNeeds([], resolveJar),
      targets: [],
      matrixPath: "/repo/mc-test.yml",
      matrixError: "unexpected token at line 4",
      workDir: "/repo/.mc-test/run",
    });
    const m = byId(r, "matrix")!;
    expect(m.status).toBe("fail");
    expect(m.blocking).toBe(true);
    expect(m.detail).toContain("unexpected token at line 4");
  });

  it("a modded agent jar that was never built → fail, but NOT blocking (it honestly skips)", async () => {
    const r = await run(
      [moddedServerTarget],
      probe({ fileExists: (p) => !p.includes("server-forge") }),
    );
    const jar = byId(r, "agent-jar:server-forge")!;
    expect(jar.status).toBe("fail");
    expect(jar.blocking).toBeUndefined();
    expect(jar.detail).toContain("NOT BUILT");
    expect(jar.remedy).toContain("gradlew build");
    // doctor is strict about it…
    expect(exitCode(r)).toBe(1);
    // …but `run` still boots and lets the step skip truthfully.
    expect(blockingFailures(r)).toEqual([]);
  });

  it("gradle is only demanded when a jar actually has to be built", async () => {
    const allBuilt = await run([moddedServerTarget], probe({ commandVersion: async (c) => (c === "gradle" ? null : "v") }));
    expect(byId(allBuilt, "gradle")).toBeUndefined();

    const needsBuild = await run(
      [moddedServerTarget],
      probe({
        fileExists: (p) => !p.includes("server-forge"),
        commandVersion: async (c) => (c === "gradle" ? null : "v"),
      }),
    );
    const g = byId(needsBuild, "gradle")!;
    expect(g.status).toBe("fail");
    expect(g.detail).toContain("server-forge");
    expect(g.remedy).toMatch(/Gradle/);
  });

  it("an old Node major → warn naming the mineflayer floor", async () => {
    const r = await run([paperTarget], probe({ nodeVersion: "v20.11.0" }));
    const n = byId(r, "node")!;
    expect(n.status).toBe("warn");
    expect(n.detail).toContain(`>= ${MIN_NODE_MAJOR}`);
    // A warning alone does not fail doctor…
    expect(exitCode(r)).toBe(0);
    // …unless --strict.
    expect(exitCode(r, { strict: true })).toBe(1);
  });
});

describe("rendered rows: a display OR the pinned Docker image", () => {
  it("no rendered target → no display check at all", async () => {
    const r = await run([paperTarget], probe({ commandVersion: async () => null, dockerImages: async () => null }));
    expect(byId(r, "display")).toBeUndefined();
  });

  it("xvfb-run present → ok", async () => {
    const r = await run([renderedTarget], probe());
    expect(byId(r, "display")!.status).toBe("ok");
  });

  it("no xvfb but the rendered image is built → ok, pointing at the container", async () => {
    const r = await run(
      [renderedTarget],
      probe({ commandVersion: async (c) => (c === "xvfb-run" ? null : "present") }),
    );
    const d = byId(r, "display")!;
    expect(d.status).toBe("ok");
    expect(d.detail).toContain(RENDERED_IMAGE);
  });

  it("no xvfb and no image → fail naming the exact docker build command", async () => {
    const r = await run(
      [renderedTarget],
      probe({
        commandVersion: async (c) => (c === "xvfb-run" ? null : "present"),
        dockerImages: async () => ["eclipse-temurin:21-jdk"],
      }),
    );
    const d = byId(r, "display")!;
    expect(d.status).toBe("fail");
    expect(d.remedy).toContain(`docker build -f Dockerfile.rendered -t ${RENDERED_IMAGE}`);
    expect(exitCode(r)).toBe(1);
  });

  it("no xvfb and Docker unreachable → fail mentioning both escape hatches", async () => {
    const r = await run(
      [renderedTarget],
      probe({
        commandVersion: async (c) => (c === "xvfb-run" ? null : "present"),
        dockerImages: async () => null,
      }),
    );
    const d = byId(r, "display")!;
    expect(d.status).toBe("fail");
    expect(d.detail).toContain("Docker is unavailable");
    expect(d.remedy).toMatch(/xvfb/i);
    expect(d.remedy).toMatch(/docker build/);
  });

  it("a desktop rendered row on headless Linux falls back to the image check", async () => {
    const desktopRow: MatrixTarget = { ...renderedTarget, display: "desktop" };
    const r = await run([desktopRow], probe({ env: {}, dockerImages: async () => [] }));
    const d = byId(r, "display")!;
    expect(d.status).toBe("fail");
    expect(d.detail).toContain("no DISPLAY");
  });

  it("forge/neoforge rendered rows warn that they are opt-in gated", async () => {
    const forgeClient: MatrixTarget = { ...renderedTarget, id: "forge-1.20.1-client", loader: "forge" };
    const gated = await run([forgeClient], probe());
    expect(byId(gated, "rendered-loaders")!.status).toBe("warn");
    expect(byId(gated, "rendered-loaders")!.detail).toContain("honestly skip");

    const optedIn = await run([forgeClient], probe({ env: { DISPLAY: ":0", MC_TEST_RENDERED_LOADERS: "forge" } }));
    expect(byId(optedIn, "rendered-loaders")).toBeUndefined();
  });
});

describe("disk thresholds scale with what the session boots", () => {
  it("7 GiB is fine for a plain headless row but warns for a rendered one", async () => {
    const sevenGib = () => 7 * 1024 ** 3;
    expect(byId(await run([paperTarget], probe({ freeDiskBytes: sevenGib })), "disk")!.status).toBe("ok");
    expect(byId(await run([renderedTarget], probe({ freeDiskBytes: sevenGib })), "disk")!.status).toBe("warn");
  });

  it("unknowable free space is a warning, never a failure", async () => {
    const r = await run([paperTarget], probe({ freeDiskBytes: () => null }));
    expect(byId(r, "disk")!.status).toBe("warn");
    expect(exitCode(r)).toBe(0);
  });
});

describe("a fully-provisioned host is clean", () => {
  it("passes every check and exits 0 even under --strict", async () => {
    const r = await run([paperTarget, renderedTarget, moddedServerTarget], probe({ env: { DISPLAY: ":0", MC_TEST_RENDERED_LOADERS: "forge,neoforge" } }));
    expect(r.checks.filter((c) => c.status !== "ok")).toEqual([]);
    expect(exitCode(r, { strict: true })).toBe(0);
    expect(formatReport(r)).toContain("all preflight checks passed");
  });
});

describe("formatReport prints a remedy line for every problem", () => {
  it("emits an arrow line under each non-ok check", async () => {
    const r = await run([paperTarget], probe({ commandVersion: async () => null, fileExists: () => false }));
    const text = formatReport(r);
    for (const c of r.checks.filter((x) => x.status !== "ok" && x.remedy)) {
      expect(text).toContain(`→ ${c.remedy}`);
    }
    expect(text).toMatch(/\d+ unmet dependenc(y|ies)/);
  });
});
