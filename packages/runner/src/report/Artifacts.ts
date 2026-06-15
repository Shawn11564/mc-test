/**
 * On-failure artifacts bundle. For the headless driver there is no screenshot
 * (no framebuffer) — we capture the server log and the per-step trace (which
 * includes the last chat lines the assertions saw).
 */
import { mkdirSync, copyFileSync, existsSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import type { TestResult } from "../model/result.js";

export interface ArtifactBundle {
  dir: string;
  files: string[];
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

/** Collect artifacts for a failed test (no-op on pass). */
export function collectArtifacts(outputDir: string, result: TestResult): ArtifactBundle {
  const dir = join(outputDir, "artifacts", sanitize(result.target), sanitize(result.name));
  if (result.outcome !== "failed") return { dir, files: [] };

  mkdirSync(dir, { recursive: true });
  const files: string[] = [];
  for (const artifact of result.artifacts ?? []) {
    if (existsSync(artifact)) {
      const dest = join(dir, basename(artifact));
      copyFileSync(artifact, dest);
      files.push(dest);
    }
  }
  const tracePath = join(dir, "steps.txt");
  writeFileSync(tracePath, result.systemOut ?? "(no step trace)", "utf8");
  files.push(tracePath);
  return { dir, files };
}
