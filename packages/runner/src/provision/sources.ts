/**
 * Source resolution + supply-chain integrity for SUT/dependency artifacts (F2).
 * A plugin/mod source is resolved to a local file path, verifying its `sha256`
 * when present. Third-party deps fetched over the network MUST carry a `sha256`
 * (a download with no integrity check is refused) so a swapped/corrupted artifact
 * fails loudly instead of silently testing the wrong code.
 *
 * Supported source kinds: `path` (local, optional sha256), `url` (download +
 * required sha256), and `modrinth` (resolved via the Modrinth API, verified
 * against Modrinth's published sha512/sha1 — F5; see `./modrinth.ts`).
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { resolveModrinth, type ModrinthRef } from "./modrinth.js";

/** A resolvable artifact source (the subset of mc-test.yml Source the runner consumes). */
export interface ArtifactSource {
  path?: string;
  url?: string;
  /** Modrinth project ref (F5): `{ project, version?, loader?, gameVersion? }`. */
  modrinth?: ModrinthRef;
  sha256?: string;
  /** Install filename override (e.g. "regions.jar"). */
  as?: string;
}

/** A file-hash algorithm the integrity layer understands. */
export type HashAlgo = "sha256" | "sha1" | "sha512";

/** Hex digest of a file under the given algorithm (default sha256). */
export function hashFile(path: string, algo: HashAlgo = "sha256"): Promise<string> {
  return new Promise((res, rej) => {
    const hash = createHash(algo);
    createReadStream(path)
      .on("data", (d) => hash.update(d))
      .on("end", () => res(hash.digest("hex")))
      .on("error", rej);
  });
}

/** Hex sha256 of a file (back-compat alias of `hashFile(path, "sha256")`). */
export function sha256File(path: string): Promise<string> {
  return hashFile(path, "sha256");
}

async function assertSha256(path: string, expected: string): Promise<void> {
  const got = await sha256File(path);
  if (got !== expected.toLowerCase()) {
    throw new Error(`ARTIFACT_CHECKSUM_MISMATCH: ${path} sha256=${got} expected=${expected.toLowerCase()}`);
  }
}

/**
 * Resolve one source to a local file path, verifying integrity:
 * - `path`: used as-is; if `sha256` is given it MUST match.
 * - `url`: downloaded into `cacheDir` (cached by checksum) — `sha256` is REQUIRED.
 * Throws on a missing file, a checksum mismatch, a failed download, or an
 * unsupported source shape.
 */
export async function resolveArtifact(source: ArtifactSource, cacheDir: string): Promise<string> {
  if (source.path) {
    const p = resolve(source.path);
    if (!existsSync(p)) {
      throw new Error(`source not found: ${p} (build the SUT first — artifacts are not committed)`);
    }
    if (source.sha256) await assertSha256(p, source.sha256);
    return p;
  }
  if (source.url) {
    if (!source.sha256) {
      throw new Error(`INTEGRITY_REQUIRED: url source needs a sha256 for verification: ${source.url}`);
    }
    mkdirSync(cacheDir, { recursive: true });
    let fileName = source.as;
    if (!fileName) {
      try {
        fileName = basename(new URL(source.url).pathname) || undefined;
      } catch {
        /* fall through to a checksum-derived name */
      }
    }
    const dest = join(cacheDir, fileName && fileName.length > 0 ? fileName : `artifact-${source.sha256.slice(0, 16)}.jar`);
    // Cache hit: reuse a previously-downloaded file iff its checksum still matches.
    if (existsSync(dest) && (await sha256File(dest)) === source.sha256.toLowerCase()) {
      return dest;
    }
    const res = await fetch(source.url);
    if (!res.ok || !res.body) {
      throw new Error(`download failed: HTTP ${res.status} for ${source.url}`);
    }
    await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(dest));
    await assertSha256(dest, source.sha256);
    return dest;
  }
  if (source.modrinth) {
    // Integrity comes from Modrinth's PUBLISHED hash (sha512/sha1), like trusting the
    // Paper fill API's sha256. A user `sha256` is an OPTIONAL extra pin (verified too).
    const p = await resolveModrinth(source.modrinth, cacheDir);
    if (source.sha256) await assertSha256(p, source.sha256);
    return p;
  }
  throw new Error(
    "unsupported plugin/mod source: provide `path` (local jar), `url` + `sha256`, or " +
      "`modrinth: { project, version }`.",
  );
}
