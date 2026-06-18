/**
 * Modrinth source resolver (F5). Resolves `{ modrinth: { project, version?, loader?,
 * gameVersion? } }` to a local jar, verified against Modrinth's PUBLISHED hash
 * (sha512, else sha1) — the supply-chain integrity for a network download, exactly
 * as the PaperMC fill API's sha256 is trusted. Used to fetch real third-party mods
 * (e.g. FerriteCore) that prove a modded server actually loads them.
 *
 * Determinism: pin `version` (a Modrinth version id) for a reproducible artifact.
 * Without it the newest file matching `loader` + `gameVersion` is chosen (and the
 * resolved id is logged so it can be pinned), which can change over time.
 */
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { hashFile } from "./sources.js";

const MODRINTH_API = "https://api.modrinth.com/v2";
// Modrinth asks every client to identify itself (an anonymous UA risks 403/429).
const USER_AGENT = "mc-test/0.1 (+https://mc-test.dev; minecraft test framework)";

/** A `modrinth:` source ref → resolved via the Modrinth API. */
export interface ModrinthRef {
  /** Project slug or id, e.g. `"ferrite-core"`. */
  project: string;
  /** Pinned version id (RECOMMENDED — deterministic). Else newest matching the filters. */
  version?: string;
  /** Loader filter when resolving by project (`fabric`/`forge`/`neoforge`/`quilt`). */
  loader?: string;
  /** Minecraft version filter when resolving by project, e.g. `"1.21.1"`. */
  gameVersion?: string;
}

export interface ModrinthResolveOptions {
  /** Forbid network (offline CI): a cache miss is a hard error. */
  offline?: boolean;
  /** Retries for transient failures (default 3). */
  retries?: number;
  /** Logger for the non-deterministic "newest chosen" note (default `console.error`). */
  log?: (msg: string) => void;
}

interface ModrinthFile {
  url: string;
  filename: string;
  primary: boolean;
  hashes: { sha512?: string; sha1?: string };
}
interface ModrinthVersion {
  id: string;
  version_number: string;
  date_published: string;
  loaders: string[];
  game_versions: string[];
  files: ModrinthFile[];
}

/** GET + parse JSON with a UA, mapping 404 → ARTIFACT_NOT_AVAILABLE and retrying transient errors. */
async function fetchJson<T>(url: string, retries: number): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
      if (res.status === 404) throw new Error(`ARTIFACT_NOT_AVAILABLE: modrinth 404 for ${url}`);
      if (!res.ok) throw new Error(`modrinth HTTP ${res.status} for ${url}`);
      return (await res.json()) as T;
    } catch (err) {
      lastErr = err;
      // A 404 is terminal (the artifact genuinely doesn't exist) — don't retry.
      if (err instanceof Error && err.message.startsWith("ARTIFACT_NOT_AVAILABLE")) throw err;
      if (attempt < retries) await delay(250 * (attempt + 1));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Resolve a Modrinth ref to a local, integrity-verified file path. Caches into
 * `cacheDir` keyed by the file's published name + hash (re-download only on a
 * checksum miss). Throws `ARTIFACT_NOT_AVAILABLE` (no matching version/file) or
 * `ARTIFACT_CHECKSUM_MISMATCH` (download didn't match the published hash).
 */
export async function resolveModrinth(
  ref: ModrinthRef,
  cacheDir: string,
  opts: ModrinthResolveOptions = {},
): Promise<string> {
  const retries = opts.retries ?? 3;
  const log = opts.log ?? ((m: string) => console.error(m));
  if (!ref.project) throw new Error("modrinth source requires a `project` (slug or id)");

  // 1. Resolve to a concrete version (pinned id → exact; else newest matching filters).
  let version: ModrinthVersion;
  if (ref.version) {
    version = await fetchJson<ModrinthVersion>(`${MODRINTH_API}/version/${encodeURIComponent(ref.version)}`, retries);
  } else {
    const params = new URLSearchParams();
    if (ref.loader) params.set("loaders", JSON.stringify([ref.loader]));
    if (ref.gameVersion) params.set("game_versions", JSON.stringify([ref.gameVersion]));
    const qs = params.toString();
    const list = await fetchJson<ModrinthVersion[]>(
      `${MODRINTH_API}/project/${encodeURIComponent(ref.project)}/version${qs ? `?${qs}` : ""}`,
      retries,
    );
    if (!list.length) {
      throw new Error(
        `ARTIFACT_NOT_AVAILABLE: modrinth ${ref.project} has no version for ` +
          `loader=${ref.loader ?? "*"} gameVersion=${ref.gameVersion ?? "*"}`,
      );
    }
    // Modrinth returns versions newest-first; take the most recent match.
    version = list[0]!;
    log(
      `modrinth: ${ref.project} → ${version.version_number} (id ${version.id}); ` +
        `pin with version: "${version.id}" for a reproducible run`,
    );
  }

  // 2. Pick the primary file (else the first).
  const file = version.files.find((f) => f.primary) ?? version.files[0];
  if (!file) throw new Error(`ARTIFACT_NOT_AVAILABLE: modrinth version ${version.id} has no files`);
  const expected = file.hashes.sha512
    ? { algo: "sha512" as const, hex: file.hashes.sha512.toLowerCase() }
    : file.hashes.sha1
      ? { algo: "sha1" as const, hex: file.hashes.sha1.toLowerCase() }
      : undefined;

  // 3. Cache by the published filename; reuse only when the hash still matches.
  mkdirSync(cacheDir, { recursive: true });
  const dest = join(cacheDir, file.filename);
  const verify = async (p: string): Promise<boolean> =>
    expected ? (await hashFile(p, expected.algo)) === expected.hex : true;
  if (existsSync(dest) && (await verify(dest))) return dest;
  if (opts.offline) throw new Error(`OFFLINE: modrinth ${ref.project} not in cache (${dest})`);

  // 4. Download + verify against the published hash.
  const res = await fetch(file.url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok || !res.body) throw new Error(`modrinth download failed: HTTP ${res.status} for ${file.url}`);
  await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(dest));
  if (!(await verify(dest))) {
    const got = expected ? await hashFile(dest, expected.algo) : "(no published hash)";
    throw new Error(
      `ARTIFACT_CHECKSUM_MISMATCH: ${dest} ${expected?.algo ?? "?"}=${got} expected=${expected?.hex ?? "?"}`,
    );
  }
  return dest;
}
