/**
 * Per-run workspace lifecycle: env-dir naming, a startup GC sweep, a Windows-aware
 * reliable remove, and the rapid-dev "reset" of a reused env.
 *
 * Why this exists: each provisioned server boots into its own `instanceDir` under
 * `.mc-test/run/`, and Paper regenerates ~130 MB of `libraries`/`cache`/`versions`
 * into it. The success path deletes the dir, but on Windows the JVM releases its
 * world-region + `session.lock` handles slowly AFTER exit, so a prompt `rmSync`
 * throws and (historically) was swallowed — leaking the whole env every run. With
 * no GC of past leaks, `.mc-test/run/` grew unbounded (observed: 45 dirs / 6.7 GB).
 *
 * The fix has three parts, all here:
 *   1. `sweepStaleEnvs` — at the START of every run, delete env dirs left by DEAD
 *      runner processes (the Windows leak, and `keepOnFailure` retention from a
 *      prior invocation). Bounded retention without losing same-run triage.
 *   2. `reliableRemove` — a longer, backed-off remove that actually outlasts the
 *      handle release, and REPORTS (rather than hides) a dir it could not delete.
 *   3. `reuseEnvName` + `resetReuseEnv` — rapid-dev mode: a stable per-target dir
 *      that is "reset" (world/logs/plugins wiped, heavy caches kept) instead of
 *      recreated, so iteration is fast AND bounded to one dir per target.
 */
import {
  rmSync,
  rmdirSync,
  unlinkSync,
  existsSync,
  readdirSync,
  statSync,
  lstatSync,
  mkdirSync,
  symlinkSync,
  cpSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";

/**
 * Per-run env dir name: `<target.id>-<gamePort>-<pid>`. The trailing `-<port>-<pid>`
 * is the GC key — `sweepStaleEnvs` parses the pid to decide if the owner is dead.
 */
export function ephemeralEnvName(targetId: string, gamePort: number, pid: number = process.pid): string {
  return `${targetId}-${gamePort}-${pid}`;
}

/**
 * Reuse (rapid-dev) env dir name: just `<target.id>`, with NO `-<port>-<pid>`
 * suffix. That stable name is intentional — it is reused across runs and is, by
 * construction, NOT eligible for the stale-env sweep (which only matches the
 * suffixed shape), so an in-flight reuse dir is never GC'd out from under a run.
 */
export function reuseEnvName(targetId: string): string {
  return targetId;
}

/** Trailing `-<gamePort>-<pid>` of an ephemeral env dir name. */
const ENV_SUFFIX_RE = /-(\d+)-(\d+)$/;

/**
 * Is a process with this pid currently alive? Uses the signal-0 probe (no signal
 * is sent; it only checks existence/permission). `EPERM` means the process exists
 * but is owned by another user — still alive, so we must NOT reclaim its dir.
 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface SweepReport {
  /** Env dirs removed because their owning runner pid is dead. */
  removed: string[];
  /** Eligible-but-undeletable dirs (e.g. a handle still held) — surfaced, not hidden. */
  leaked: string[];
}

/**
 * GC orphaned per-run env dirs in `workDir` left by DEAD runner processes — the
 * Windows handle-leak on the success path, or `keepOnFailure` retention from a
 * prior invocation. A dir is eligible only when its name matches `<id>-<port>-<pid>`
 * AND that pid is neither alive nor our own (`selfPid`). PID reuse can leave a
 * genuinely-stale dir behind for one extra cycle (we treat a reused-but-alive pid
 * as live) — the safe direction; we never delete a dir whose pid is currently alive,
 * so a concurrent run's in-flight envs are protected.
 */
export function sweepStaleEnvs(workDir: string, selfPid: number = process.pid): SweepReport {
  const report: SweepReport = { removed: [], leaked: [] };
  if (!existsSync(workDir)) return report;
  let entries: string[];
  try {
    entries = readdirSync(workDir);
  } catch {
    return report;
  }
  for (const name of entries) {
    const m = ENV_SUFFIX_RE.exec(name);
    if (!m) continue; // not a per-run env dir (e.g. a reuse dir, or unrelated)
    const pid = Number(m[2]);
    if (pid === selfPid || pidAlive(pid)) continue; // ours, or a live owner — leave it
    const dir = join(workDir, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    if (removeEnvDir(dir)) report.removed.push(name);
    else report.leaked.push(name);
  }
  return report;
}

/**
 * Remove a dir, riding out the slow post-exit handle release Paper exhibits on
 * Windows (world-region files + `session.lock`). Backs off up to ~3.7 s total
 * (8 tries: 50,100,200,…), far longer than the old 3×200 ms which routinely lost
 * the race. Returns whether the dir is gone — the caller LOGS a leak rather than
 * silently swallowing it, so a persistent leak is visible instead of invisible.
 */
export function reliableRemove(dir: string): boolean {
  if (!existsSync(dir)) return true;
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  } catch {
    /* fall through to the existence check */
  }
  return !existsSync(dir);
}

/** World dirs for a level (Bukkit sibling-dimension layout) + per-run scratch. */
function resettablePaths(instanceDir: string, levelName: string): string[] {
  return [
    join(instanceDir, levelName),
    join(instanceDir, `${levelName}_nether`),
    join(instanceDir, `${levelName}_the_end`),
    join(instanceDir, "logs"),
    join(instanceDir, "plugins"),
    join(instanceDir, "mods"),
    join(instanceDir, "crash-reports"),
  ];
}

/**
 * Rapid-dev "reset" of a reused env (`--reuse`): wipe the per-run state — worlds,
 * logs, and the SUT plugins/mods (re-installed fresh from the freshly-built jar) —
 * while KEEPING the heavy regenerables (`libraries`/`cache`/`versions`, ~130 MB)
 * so the next boot skips re-downloading them. Turns a reused dir back into a clean
 * boot surface without paying the full provision cost.
 */
export function resetReuseEnv(instanceDir: string, levelName: string = "world"): void {
  if (!existsSync(instanceDir)) return;
  for (const p of resettablePaths(instanceDir, levelName)) {
    reliableRemove(p);
  }
}

// ───────────────────────────── shared runtime cache (item D) ─────────────────────────────

/**
 * The heavy regenerables a fresh server boots into its cwd and re-downloads every
 * run, identical for every run of the same server build (so shared per-build — see
 * `linkSharedRuntime`). A superset across loaders; a dir absent for a given server
 * (e.g. Paper has no `.fabric`, Fabric has no `cache`) is simply skipped:
 *   - `libraries` — Mojang/Paper/loader dependency jars (all loaders);
 *   - `cache`     — Paper's paperclip patch cache (~47 MB on Paper);
 *   - `versions`  — the versioned (patched) server jar;
 *   - `.fabric`   — Fabric's remapped-jar cache (~68 MB — Fabric's single biggest dir).
 */
export const HEAVY_DIRS = ["libraries", "cache", "versions", ".fabric"] as const;

/** Marker written into a shared runtime dir once it is fully populated + safe to share. */
const READY_MARKER = ".mctp-ready";

/** Per-(server build) shared runtime cache dir under `<cacheDir>/runtime/<key>`. */
export function sharedRuntimeDir(cacheDir: string, key: string): string {
  return join(cacheDir, "runtime", key.replace(/[^A-Za-z0-9._-]/g, "_"));
}

/** Remove `p` only if it is a symlink/junction (the link itself, never its target). */
function unlinkIfLink(p: string): boolean {
  let st;
  try {
    st = lstatSync(p);
  } catch {
    return false; // does not exist
  }
  if (!st.isSymbolicLink()) return false; // a real dir/file — not ours to unlink here
  try {
    unlinkSync(p);
  } catch {
    try {
      rmdirSync(p); // Windows directory junctions sometimes need rmdir, not unlink
    } catch {
      /* leave it; reliableRemove can still try */
    }
  }
  return true;
}

const junctionType = (): "junction" | "dir" => (process.platform === "win32" ? "junction" : "dir");

export interface RuntimeShare {
  /** `warm` = junctioned to a ready cache; `cold` = will populate + publish; `off` = disabled. */
  mode: "warm" | "cold" | "off";
  shared: string;
}

/**
 * Before boot: if the shared runtime for this build is READY, junction the env's
 * heavy dirs to it (`warm`) so the server finds them present and skips the ~130 MB
 * re-download. Otherwise the env populates them privately (`cold`), to be published
 * on success by `publishSharedRuntime`. Junctions (Windows) / symlinks (POSIX) need
 * no elevation. Read-only sharing is safe for concurrent warm readers — the dirs are
 * immutable once published. Any failure degrades silently to a private download.
 */
export function linkSharedRuntime(instanceDir: string, shared: string, enabled: boolean): RuntimeShare {
  if (!enabled) return { mode: "off", shared };
  if (!existsSync(join(shared, READY_MARKER))) return { mode: "cold", shared };
  for (const d of HEAVY_DIRS) {
    const target = join(shared, d);
    if (!existsSync(target)) continue; // ready but this dir was absent — leave it private
    const link = join(instanceDir, d);
    unlinkIfLink(link);
    if (existsSync(link)) reliableRemove(link); // clear a stale real dir (e.g. a reuse leftover)
    try {
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(target, link, junctionType());
    } catch {
      /* couldn't junction — the server just downloads this dir privately */
    }
  }
  return { mode: "warm", shared };
}

/**
 * After a COLD env boots successfully, publish its freshly-downloaded heavy dirs to
 * the shared cache so future envs go warm. Best-effort + single-publisher (an atomic
 * lock dir); a no-op for warm/off or if another env already published. The ready
 * marker is written LAST so a crash mid-copy leaves the cache "unready" (ignored +
 * re-published next time) rather than half-shared.
 */
export function publishSharedRuntime(instanceDir: string, share: RuntimeShare): boolean {
  if (share.mode !== "cold") return false;
  const shared = share.shared;
  if (existsSync(join(shared, READY_MARKER))) return false;
  mkdirSync(shared, { recursive: true });
  const lock = join(shared, ".publish.lock");
  try {
    mkdirSync(lock); // atomic: throws if another publisher holds it
  } catch {
    return false;
  }
  try {
    if (existsSync(join(shared, READY_MARKER))) return false;
    for (const d of HEAVY_DIRS) {
      const src = join(instanceDir, d);
      if (!existsSync(src) || lstatSync(src).isSymbolicLink()) continue; // only real, locally-populated dirs
      reliableRemove(join(shared, d)); // clean any partial leftover from a prior aborted publish
      cpSync(src, join(shared, d), { recursive: true });
    }
    writeFileSync(join(shared, READY_MARKER), "ready\n");
    return true;
  } catch {
    return false; // best-effort: leave unready for the next cold env to retry
  } finally {
    try {
      rmdirSync(lock);
    } catch {
      /* ignore */
    }
  }
}

// ───────────────────────────── junction-safe env removal + purge ─────────────────────────────

/**
 * Remove a per-run env dir SAFELY when its heavy dirs may be junctions into the
 * shared runtime cache: unlink those junctions FIRST (removing the link, never the
 * shared target) before recursively deleting the rest. Without this, a recursive
 * delete could follow a junction and wipe the shared cache. Returns whether the dir
 * is gone.
 */
export function removeEnvDir(instanceDir: string): boolean {
  for (const d of HEAVY_DIRS) unlinkIfLink(join(instanceDir, d));
  return reliableRemove(instanceDir);
}

/** Best-effort recursive byte size of a dir (for reclaimed-space reporting). */
export function dirSizeBytes(dir: string): number {
  let total = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    const p = join(dir, name);
    let st;
    try {
      st = lstatSync(p);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue; // a junction's target isn't this env's bytes
    if (st.isDirectory()) total += dirSizeBytes(p);
    else total += st.size;
  }
  return total;
}

export interface PurgeReport {
  removed: string[];
  freedBytes: number;
  /** Env dirs left in place because their owning PID is still alive (skipped unless `all`). */
  keptLive: string[];
  leaked: string[];
}

/**
 * Purge env dirs in `workDir` (the `mc-test clean` backend). Default removes only
 * dirs safe to reclaim — per-run envs whose owning PID is dead (same rule as the
 * startup sweep) — and skips a live run's envs. `all: true` wipes EVERY entry
 * (including reuse dirs and live ones — a `gradle clean`-style hard reset).
 * `dryRun: true` reports what would be removed without deleting.
 */
export function purgeWorkspace(
  workDir: string,
  opts: { all?: boolean; dryRun?: boolean } = {},
): PurgeReport {
  const report: PurgeReport = { removed: [], freedBytes: 0, keptLive: [], leaked: [] };
  if (!existsSync(workDir)) return report;
  let entries: string[];
  try {
    entries = readdirSync(workDir);
  } catch {
    return report;
  }
  for (const name of entries) {
    const dir = join(workDir, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    if (!opts.all) {
      const m = ENV_SUFFIX_RE.exec(name);
      if (!m) continue; // not a reclaimable per-run env (e.g. a reuse dir) — needs --all
      const pid = Number(m[2]);
      if (pidAlive(pid)) {
        report.keptLive.push(name);
        continue;
      }
    }
    const bytes = dirSizeBytes(dir);
    if (opts.dryRun) {
      report.removed.push(name);
      report.freedBytes += bytes;
      continue;
    }
    if (removeEnvDir(dir)) {
      report.removed.push(name);
      report.freedBytes += bytes;
    } else {
      report.leaked.push(name);
    }
  }
  return report;
}
