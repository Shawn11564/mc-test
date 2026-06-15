/**
 * Parse + lightly validate `mc-test.yml` (the M2 subset). Resolves a world ref
 * and enforces the `online-mode: true` rejection (ENVIRONMENTS.md §2.7/§8).
 */
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type { MatrixFile, MatrixTarget, WorldDef } from "../model/Target.js";

/** Parse an already-deserialized matrix document. */
export function parseMatrix(doc: unknown, src: string): MatrixFile {
  if (!doc || typeof doc !== "object") throw new Error(`${src}: not a YAML mapping`);
  const d = doc as Record<string, unknown>;
  if (typeof d["version"] !== "number") {
    throw new Error(`${src}: 'version' (int) is required`);
  }
  const targets = d["targets"];
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error(`${src}: 'targets' must be a non-empty list`);
  }
  for (const t of targets as MatrixTarget[]) {
    if (!t.id) throw new Error(`${src}: every target needs an 'id'`);
    if (t["online-mode"] === true) {
      throw new Error(`ONLINE_MODE_REJECTED: target '${t.id}' set online-mode: true (forced false in CI)`);
    }
  }
  return d as unknown as MatrixFile;
}

/** Load and parse `mc-test.yml`. */
export function loadMatrix(path: string): MatrixFile {
  return parseMatrix(parse(readFileSync(path, "utf8")), path);
}

/** Find a target by id. */
export function findTarget(matrix: MatrixFile, id: string): MatrixTarget | undefined {
  return matrix.targets.find((t) => t.id === id);
}

/** Resolve a target's world (inline or `{ ref }`). */
export function resolveWorld(matrix: MatrixFile, target: MatrixTarget): WorldDef | undefined {
  const w = target.world;
  if (!w) return undefined;
  if ("ref" in w) return matrix.worlds?.[w.ref];
  return w;
}
