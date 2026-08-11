/**
 * Parse + lightly validate `mc-test.yml` (the M2 subset). Resolves a world ref
 * and enforces the `online-mode: true` rejection (ENVIRONMENTS.md §2.7/§8).
 */
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type { MatrixFile, MatrixTarget, WorldDef } from "../model/Target.js";

/**
 * The REAL `mc-test.yml` key surface, mirrored from `model/Target.ts`. Kept as plain
 * key lists (not derived from the TS types, which erase at runtime) so an unknown key —
 * a typo, or a field from an aspirational/old doc that was never wired up — is caught at
 * parse time instead of silently doing nothing (the "YAML fiction" failure mode).
 */
const KNOWN_ROOT_KEYS = ["version", "provision", "worlds", "targets"];
const KNOWN_PROVISION_KEYS = [
  "eulaAccepted",
  "bindHost",
  "portRange",
  "cacheDir",
  "workDir",
  "keepOnFailure",
  "keepWorkDir",
  "reuse",
  "shareRuntime",
  "jdks",
  "downloadJdks",
];
const KNOWN_WORLD_KEYS = ["snapshot", "levelName"];
const KNOWN_WORLD_SNAPSHOT_KEYS = ["path"];
const KNOWN_WORLD_REF_KEYS = ["ref"];
/** `Source` shape (server/plugins/mods/loaderInstaller/agentSources entries). */
const KNOWN_SOURCE_KEYS = ["path", "url", "paper", "spigot", "modrinth", "sha256", "as"];
const KNOWN_PAPER_KEYS = ["project", "version", "build"];
const KNOWN_SPIGOT_KEYS = ["version"];
const KNOWN_MODRINTH_KEYS = ["project", "version", "loader", "gameVersion"];
const KNOWN_TARGET_KEYS = [
  "id",
  "loader",
  "mc",
  "loaderVersion",
  "loaderInstaller",
  "driver",
  "via",
  "server",
  "plugins",
  "mods",
  "clientMods",
  "display",
  "agents",
  "agentSources",
  "expectMods",
  "world",
  "serverProps",
  "ops",
  "timeoutSec",
  "online-mode",
];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Push one warning for every key of `obj` not in `known`, prefixed with `path`. */
function checkKeys(obj: unknown, known: string[], path: string, warnings: string[]): void {
  if (!isPlainObject(obj)) return;
  for (const key of Object.keys(obj)) {
    if (!known.includes(key)) warnings.push(`${path}.${key}`);
  }
}

function checkSource(src: unknown, path: string, warnings: string[]): void {
  if (!isPlainObject(src)) return;
  checkKeys(src, KNOWN_SOURCE_KEYS, path, warnings);
  checkKeys(src["paper"], KNOWN_PAPER_KEYS, `${path}.paper`, warnings);
  checkKeys(src["spigot"], KNOWN_SPIGOT_KEYS, `${path}.spigot`, warnings);
  checkKeys(src["modrinth"], KNOWN_MODRINTH_KEYS, `${path}.modrinth`, warnings);
}

function checkWorld(world: unknown, path: string, warnings: string[]): void {
  if (!isPlainObject(world)) return;
  if ("ref" in world) {
    checkKeys(world, KNOWN_WORLD_REF_KEYS, path, warnings);
    return;
  }
  checkKeys(world, KNOWN_WORLD_KEYS, path, warnings);
  checkKeys(world["snapshot"], KNOWN_WORLD_SNAPSHOT_KEYS, `${path}.snapshot`, warnings);
}

function checkTarget(t: unknown, path: string, warnings: string[]): void {
  if (!isPlainObject(t)) return;
  checkKeys(t, KNOWN_TARGET_KEYS, path, warnings);
  checkSource(t["server"], `${path}.server`, warnings);
  checkSource(t["loaderInstaller"], `${path}.loaderInstaller`, warnings);
  for (const [i, p] of ((t["plugins"] as unknown[]) ?? []).entries()) {
    checkSource(p, `${path}.plugins[${i}]`, warnings);
  }
  for (const [i, m] of ((t["clientMods"] as unknown[]) ?? []).entries()) {
    checkSource(m, `${path}.clientMods[${i}]`, warnings);
  }
  for (const [i, m] of ((t["mods"] as unknown[]) ?? []).entries()) {
    checkSource(m, `${path}.mods[${i}]`, warnings);
  }
  const agentSources = t["agentSources"];
  if (isPlainObject(agentSources)) {
    for (const name of Object.keys(agentSources)) {
      checkSource(agentSources[name], `${path}.agentSources.${name}`, warnings);
    }
  }
  checkWorld(t["world"], `${path}.world`, warnings);
}

/** Collect `dotted.path` warnings for every key in `doc` unknown to the real `mc-test.yml` schema. */
export function collectUnknownKeys(doc: unknown): string[] {
  if (!isPlainObject(doc)) return [];
  const warnings: string[] = [];
  checkKeys(doc, KNOWN_ROOT_KEYS, "$", warnings);
  checkKeys(doc["provision"], KNOWN_PROVISION_KEYS, "$.provision", warnings);
  const worlds = doc["worlds"];
  if (isPlainObject(worlds)) {
    for (const name of Object.keys(worlds)) {
      checkWorld(worlds[name], `$.worlds.${name}`, warnings);
    }
  }
  for (const [i, t] of ((doc["targets"] as unknown[]) ?? []).entries()) {
    checkTarget(t, `$.targets[${i}]`, warnings);
  }
  return warnings;
}

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
  for (const key of collectUnknownKeys(doc)) {
    console.warn(`  ⚠ ${src}: unknown config key '${key}' (typo, or not implemented — ignored)`);
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
