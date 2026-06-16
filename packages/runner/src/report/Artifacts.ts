/**
 * On-failure artifacts bundle. We capture the server log, the per-step trace
 * (which includes the last chat lines the assertions saw), and — when a
 * `screenshot`-capable driver ran — any PNGs the run produced (explicit
 * `screenshot` steps + the on-failure auto-capture), copied into the bundle dir.
 */
import { mkdirSync, copyFileSync, existsSync, writeFileSync } from "node:fs";
import { join, basename, isAbsolute } from "node:path";
import type { TestResult } from "../model/result.js";

export interface ArtifactBundle {
  dir: string;
  files: string[];
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

/**
 * The per-test artifacts directory: `<outputDir>/artifacts/<target>/<name>/`.
 * The single source of truth for where a test's PNGs / logs land, so the run
 * (which writes screenshots into it) and `collectArtifacts` (which copies the
 * failure bundle there) agree on one path.
 */
export function artifactDirFor(outputDir: string, target: string, name: string): string {
  return join(outputDir, "artifacts", sanitize(target), sanitize(name));
}

/**
 * The per-target baseline directory: `<outputDir>/baselines/<target>/`. Baselines
 * are keyed per target (a 1.20.4 frame and a 1.21 frame differ legitimately), with
 * the screenshot's `name`/slot as the file key inside.
 */
export function baselineDirFor(outputDir: string, target: string): string {
  return join(outputDir, "baselines", sanitize(target));
}

/**
 * Collect artifacts for a test. On failure (or whenever the test produced
 * artifacts, e.g. an explicit `screenshot` step on a passing test) the recorded
 * `artifacts[]` are copied into the bundle dir; on failure a `steps.txt` trace is
 * also written. Paths that already live inside the bundle dir are left in place
 * (the run wrote screenshots straight there) and reported as-is.
 */
export function collectArtifacts(outputDir: string, result: TestResult): ArtifactBundle {
  const dir = artifactDirFor(outputDir, result.target, result.name);
  const recorded = result.artifacts ?? [];
  // Nothing to do on a clean pass with no artifacts.
  if (result.outcome !== "failed" && recorded.length === 0) return { dir, files: [] };

  mkdirSync(dir, { recursive: true });
  const files: string[] = [];
  const seen = new Set<string>();
  for (const artifact of recorded) {
    if (!existsSync(artifact)) continue;
    // Screenshots the run wrote are already in `dir`; copy only artifacts from
    // elsewhere (e.g. the server log) so we don't copy a file onto itself.
    const dest =
      isAbsolute(artifact) && artifact.startsWith(dir) ? artifact : join(dir, basename(artifact));
    if (dest !== artifact) copyFileSync(artifact, dest);
    if (!seen.has(dest)) {
      files.push(dest);
      seen.add(dest);
    }
  }
  if (result.outcome === "failed") {
    const tracePath = join(dir, "steps.txt");
    writeFileSync(tracePath, result.systemOut ?? "(no step trace)", "utf8");
    if (!seen.has(tracePath)) files.push(tracePath);
  }
  return { dir, files };
}
