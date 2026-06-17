/**
 * Bounded-concurrency matrix run loop (F4 / ROADMAP §6.3 "per-target
 * parallelism"). The matrix is `(target × test)` jobs; per-target isolation
 * (distinct leased ports + per-instance world copies, see `PaperProvisioner`)
 * already makes the jobs independent, so the only thing missing was a pool that
 * runs up to N at a time.
 *
 * This is deliberately a tiny, dependency-free worker pool kept SEPARATE from the
 * CLI so it is unit-testable without a boot: it preserves **input order** in the
 * returned results array (so the aggregated JUnit/skip-matrix are deterministic
 * regardless of completion order) while never running more than `concurrency`
 * jobs at once.
 */

/**
 * Run `count` jobs with at most `concurrency` in flight, returning their results
 * in INPUT order (result[i] is the result of job i), regardless of the order they
 * finish. `run(i)` is invoked exactly once per index. A job that rejects rejects
 * the whole call (the CLI's `runOneTarget` never rejects — it returns a failed/
 * skipped `TestResult` — so in practice this resolves with one result per job).
 */
export async function runMatrix<R>(
  count: number,
  concurrency: number,
  run: (index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(count);
  if (count === 0) return results;
  const limit = Math.max(1, Math.min(concurrency, count));
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= count) return;
      results[i] = await run(i);
    }
  };
  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}

/**
 * Resolve the requested concurrency from a CLI flag value against the job count.
 * Absent/invalid → 1 (sequential, the default: readable streamed output and no
 * surprise resource use — booting several Minecraft servers at once is heavy, so
 * parallelism is opt-in). `"auto"` → a modest pool bounded by the job count and a
 * cap (matrix runs are server-boot-bound, not CPU-bound). Any positive integer is
 * honored (clamped to ≥1 and to the job count). Never returns more than `jobs`.
 */
export function resolveConcurrency(flag: string | undefined, jobs: number): number {
  const cap = Math.max(1, jobs);
  if (flag === undefined) return 1;
  if (flag === "auto") return Math.min(AUTO_CONCURRENCY, cap);
  const n = Number.parseInt(flag, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, cap);
}

/** The `--concurrency auto` pool size (server-boot-bound; kept modest). */
export const AUTO_CONCURRENCY = 4;
