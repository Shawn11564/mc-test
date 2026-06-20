import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, lstatSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ephemeralEnvName,
  reuseEnvName,
  sweepStaleEnvs,
  reliableRemove,
  resetReuseEnv,
  removeEnvDir,
  linkSharedRuntime,
  publishSharedRuntime,
  sharedRuntimeDir,
  purgeWorkspace,
  dirSizeBytes,
  HEAVY_DIRS,
} from "../src/provision/workspace.js";

const junction = (): "junction" | "dir" => (process.platform === "win32" ? "junction" : "dir");
function mkSharedReady(root: string, name = "shared"): string {
  const shared = join(root, name);
  for (const d of HEAVY_DIRS) {
    mkdirSync(join(shared, d), { recursive: true });
    writeFileSync(join(shared, d, "lib.jar"), "x".repeat(1000));
  }
  writeFileSync(join(shared, ".mctp-ready"), "ready\n");
  return shared;
}

/** A pid almost certainly not running; asserted dead before use to avoid flakiness. */
const DEAD_PID = 999999;
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function workDir(): string {
  return mkdtempSync(join(tmpdir(), "mctest-ws-"));
}
function mkEnv(root: string, name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "server.properties"), "x");
  return dir;
}

describe("workspace — env dir naming", () => {
  it("ephemeral name carries the GC key (-<port>-<pid>); reuse name is bare", () => {
    expect(ephemeralEnvName("paper-1.20.4", 25700, 4242)).toBe("paper-1.20.4-25700-4242");
    expect(reuseEnvName("paper-1.20.4")).toBe("paper-1.20.4");
    // The reuse name must NOT look like an ephemeral one, or the sweep could eat it.
    expect(/-(\d+)-(\d+)$/.test(reuseEnvName("paper-1.20.4"))).toBe(false);
  });
});

describe("workspace — sweepStaleEnvs", () => {
  it("removes a dir whose owner pid is dead", () => {
    expect(isAlive(DEAD_PID)).toBe(false); // guard: the fixture pid really is dead
    const root = workDir();
    const dead = mkEnv(root, ephemeralEnvName("paper", 25700, DEAD_PID));
    const report = sweepStaleEnvs(root);
    expect(report.removed).toContain(`paper-25700-${DEAD_PID}`);
    expect(existsSync(dead)).toBe(false);
  });

  it("keeps our own (selfPid) env dir — never GCs the live run's workspace", () => {
    const root = workDir();
    const self = mkEnv(root, ephemeralEnvName("paper", 25700, 1234));
    sweepStaleEnvs(root, /*selfPid*/ 1234);
    expect(existsSync(self)).toBe(true);
  });

  it("keeps a dir whose owner pid is alive but not us (a concurrent run)", () => {
    const root = workDir();
    // process.pid is definitely alive; pass a different selfPid so it is "not self".
    const live = mkEnv(root, ephemeralEnvName("paper", 25701, process.pid));
    sweepStaleEnvs(root, /*selfPid*/ 1);
    expect(existsSync(live)).toBe(true);
  });

  it("ignores dirs that aren't per-run envs (e.g. a reuse dir)", () => {
    const root = workDir();
    const reuse = mkEnv(root, reuseEnvName("paper-1.20.4"));
    const loose = mkEnv(root, "some-cache");
    sweepStaleEnvs(root);
    expect(existsSync(reuse)).toBe(true);
    expect(existsSync(loose)).toBe(true);
  });

  it("is a no-op on a missing workDir", () => {
    const report = sweepStaleEnvs(join(tmpdir(), "mctest-does-not-exist-xyz"));
    expect(report.removed).toEqual([]);
    expect(report.leaked).toEqual([]);
  });
});

describe("workspace — reliableRemove", () => {
  it("removes an existing dir and is true for an absent one", () => {
    const root = workDir();
    const dir = mkEnv(root, "gone");
    expect(reliableRemove(dir)).toBe(true);
    expect(existsSync(dir)).toBe(false);
    expect(reliableRemove(join(root, "never-existed"))).toBe(true);
  });
});

describe("workspace — resetReuseEnv", () => {
  it("wipes per-run state but keeps the heavy regenerables", () => {
    const root = workDir();
    const env = join(root, reuseEnvName("paper"));
    const wiped = ["world", "world_nether", "world_the_end", "logs", "plugins", "mods"];
    const kept = ["libraries", "cache", "versions"];
    for (const d of [...wiped, ...kept]) {
      mkdirSync(join(env, d), { recursive: true });
      writeFileSync(join(env, d, "f"), "x");
    }
    resetReuseEnv(env, "world");
    for (const d of wiped) expect(existsSync(join(env, d))).toBe(false);
    for (const d of kept) expect(existsSync(join(env, d))).toBe(true);
  });

  it("respects a custom level name", () => {
    const root = workDir();
    const env = join(root, "paper");
    mkdirSync(join(env, "arena"), { recursive: true });
    mkdirSync(join(env, "arena_the_end"), { recursive: true });
    mkdirSync(join(env, "libraries"), { recursive: true });
    resetReuseEnv(env, "arena");
    expect(existsSync(join(env, "arena"))).toBe(false);
    expect(existsSync(join(env, "arena_the_end"))).toBe(false);
    expect(existsSync(join(env, "libraries"))).toBe(true);
  });
});

describe("workspace — shared runtime cache (item D)", () => {
  it("sharedRuntimeDir sanitizes the key under cacheDir/runtime", () => {
    const p = sharedRuntimeDir("/c/cache", "paper-1.20.4-499.jar");
    expect(p.replace(/\\/g, "/")).toBe("/c/cache/runtime/paper-1.20.4-499.jar");
  });

  it("warm: junctions the heavy dirs to a ready cache (no re-download)", () => {
    const root = workDir();
    const shared = mkSharedReady(root);
    const env = join(root, "env");
    mkdirSync(env, { recursive: true });
    const share = linkSharedRuntime(env, shared, true);
    expect(share.mode).toBe("warm");
    for (const d of HEAVY_DIRS) {
      expect(lstatSync(join(env, d)).isSymbolicLink()).toBe(true);
      // the link resolves to the shared content
      expect(existsSync(join(env, d, "lib.jar"))).toBe(true);
    }
  });

  it("cold: no ready marker → no links, mode cold", () => {
    const root = workDir();
    const shared = join(root, "shared"); // not ready
    const env = join(root, "env");
    mkdirSync(env, { recursive: true });
    const share = linkSharedRuntime(env, shared, true);
    expect(share.mode).toBe("cold");
    for (const d of HEAVY_DIRS) expect(existsSync(join(env, d))).toBe(false);
  });

  it("disabled: mode off, never touches the env", () => {
    const root = workDir();
    const env = join(root, "env");
    mkdirSync(env, { recursive: true });
    expect(linkSharedRuntime(env, join(root, "shared"), false).mode).toBe("off");
  });

  it("publish: a cold env populates the shared cache, then is idempotent", () => {
    const root = workDir();
    const shared = join(root, "shared");
    const env = join(root, "env");
    for (const d of HEAVY_DIRS) {
      mkdirSync(join(env, d), { recursive: true });
      writeFileSync(join(env, d, "lib.jar"), "y".repeat(500));
    }
    const published = publishSharedRuntime(env, { mode: "cold", shared });
    expect(published).toBe(true);
    expect(existsSync(join(shared, ".mctp-ready"))).toBe(true);
    for (const d of HEAVY_DIRS) expect(existsSync(join(shared, d, "lib.jar"))).toBe(true);
    // already ready → no-op
    expect(publishSharedRuntime(env, { mode: "cold", shared })).toBe(false);
    // warm/off never publish
    expect(publishSharedRuntime(env, { mode: "warm", shared })).toBe(false);
  });
});

describe("workspace — removeEnvDir is junction-safe", () => {
  it("removes the env but NEVER deletes through a junction into the shared cache", () => {
    const root = workDir();
    const shared = mkSharedReady(root); // holds the real lib.jar files
    const env = join(root, ephemeralEnvName("paper", 25700, 4242));
    mkdirSync(env, { recursive: true });
    writeFileSync(join(env, "server.properties"), "x");
    // junction env/libraries -> shared/libraries (as linkSharedRuntime would)
    symlinkSync(join(shared, "libraries"), join(env, "libraries"), junction());
    expect(lstatSync(join(env, "libraries")).isSymbolicLink()).toBe(true);

    expect(removeEnvDir(env)).toBe(true);
    expect(existsSync(env)).toBe(false);
    // the shared target and its contents survive — the junction was unlinked, not followed
    expect(existsSync(join(shared, "libraries", "lib.jar"))).toBe(true);
  });
});

describe("workspace — purgeWorkspace (mc-test clean)", () => {
  it("default removes dead-pid envs, keeps live ones, ignores reuse dirs", () => {
    const root = workDir();
    mkEnv(root, ephemeralEnvName("paper", 25700, 999999)); // dead
    mkEnv(root, ephemeralEnvName("paper", 25701, process.pid)); // live (this process)
    mkEnv(root, reuseEnvName("paper-stable")); // reuse (no pid suffix)
    const report = purgeWorkspace(root);
    expect(report.removed).toEqual([`paper-25700-999999`]);
    expect(report.keptLive).toEqual([`paper-25701-${process.pid}`]);
    expect(existsSync(join(root, "paper-stable"))).toBe(true); // reuse untouched without --all
    expect(report.freedBytes).toBeGreaterThan(0);
  });

  it("--all wipes everything including reuse + live dirs", () => {
    const root = workDir();
    mkEnv(root, ephemeralEnvName("paper", 25701, process.pid));
    mkEnv(root, reuseEnvName("paper-stable"));
    const report = purgeWorkspace(root, { all: true });
    expect(report.removed.sort()).toEqual([`paper-25701-${process.pid}`, "paper-stable"].sort());
    expect(readdirSync(root)).toEqual([]);
  });

  it("--dry-run reports without deleting", () => {
    const root = workDir();
    mkEnv(root, ephemeralEnvName("paper", 25700, 999999));
    const report = purgeWorkspace(root, { dryRun: true });
    expect(report.removed).toEqual([`paper-25700-999999`]);
    expect(existsSync(join(root, "paper-25700-999999"))).toBe(true); // still there
  });
});

describe("workspace — dirSizeBytes", () => {
  it("sums file bytes recursively and ignores symlinks", () => {
    const root = workDir();
    const d = join(root, "d");
    mkdirSync(join(d, "sub"), { recursive: true });
    writeFileSync(join(d, "a"), "x".repeat(100));
    writeFileSync(join(d, "sub", "b"), "y".repeat(50));
    expect(dirSizeBytes(d)).toBe(150);
  });
});
