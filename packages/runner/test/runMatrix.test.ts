/**
 * F4 / ROADMAP §6.3 — per-target parallelism. The matrix run loop is a bounded
 * worker pool: it must (1) preserve INPUT order in the results (so the aggregated
 * JUnit + skip matrix are deterministic no matter which job finishes first),
 * (2) never run more than `concurrency` jobs at once, and (3) run every job
 * exactly once. These are unit-tested with no Minecraft boot — the property the
 * CLI relies on when it fans `(target × test)` jobs through the pool.
 */
import { describe, it, expect } from "vitest";
import { runMatrix, resolveConcurrency, AUTO_CONCURRENCY } from "../src/engine/runMatrix.js";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("runMatrix — bounded-concurrency, order-preserving pool", () => {
  it("returns results in INPUT order even when jobs finish out of order", async () => {
    // Job i sleeps (count-i) ms, so LATER jobs finish FIRST — yet results must be
    // in input order (result[i] === i*10).
    const count = 6;
    const out = await runMatrix(count, 3, async (i) => {
      await tick((count - i) * 5);
      return i * 10;
    });
    expect(out).toEqual([0, 10, 20, 30, 40, 50]);
  });

  it("never exceeds the concurrency limit and runs each job exactly once", async () => {
    let active = 0;
    let maxActive = 0;
    const ran: number[] = [];
    const count = 10;
    const limit = 3;
    await runMatrix(count, limit, async (i) => {
      active++;
      maxActive = Math.max(maxActive, active);
      ran.push(i);
      await tick(2);
      active--;
      return i;
    });
    expect(maxActive).toBe(limit); // saturates (count > limit), never over
    expect(maxActive).toBeLessThanOrEqual(limit);
    expect(ran.slice().sort((a, b) => a - b)).toEqual([...Array(count).keys()]);
  });

  it("concurrency 1 is strictly sequential (no overlap)", async () => {
    let active = 0;
    let maxActive = 0;
    await runMatrix(5, 1, async (i) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await tick(1);
      active--;
      return i;
    });
    expect(maxActive).toBe(1);
  });

  it("caps the pool at the job count (concurrency > jobs)", async () => {
    let active = 0;
    let maxActive = 0;
    await runMatrix(2, 16, async (i) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await tick(1);
      active--;
      return i;
    });
    expect(maxActive).toBe(2); // only 2 jobs, so only 2 ever in flight
  });

  it("handles an empty matrix", async () => {
    expect(await runMatrix(0, 4, async () => 1)).toEqual([]);
  });

  it("propagates a job rejection (the CLI's runOneTarget never rejects, but the pool is honest)", async () => {
    await expect(
      runMatrix(3, 2, async (i) => {
        if (i === 1) throw new Error("boom");
        return i;
      }),
    ).rejects.toThrow("boom");
  });
});

describe("resolveConcurrency — CLI flag → pool size", () => {
  it("defaults to 1 (sequential) when the flag is absent", () => {
    expect(resolveConcurrency(undefined, 8)).toBe(1);
  });

  it("'auto' is a modest pool bounded by the job count", () => {
    expect(resolveConcurrency("auto", 100)).toBe(AUTO_CONCURRENCY);
    expect(resolveConcurrency("auto", 2)).toBe(2); // never more than the jobs
  });

  it("honors a positive integer, clamped to the job count", () => {
    expect(resolveConcurrency("3", 8)).toBe(3);
    expect(resolveConcurrency("16", 5)).toBe(5);
  });

  it("falls back to 1 on garbage / non-positive values", () => {
    expect(resolveConcurrency("0", 8)).toBe(1);
    expect(resolveConcurrency("-2", 8)).toBe(1);
    expect(resolveConcurrency("nonsense", 8)).toBe(1);
  });

  it("never returns more than the job count (even with 0 jobs)", () => {
    expect(resolveConcurrency("4", 0)).toBe(1);
  });
});
