/**
 * Source resolution + supply-chain integrity for SUT/dependency artifacts (F2).
 * A plugin/mod source is resolved to a local file path, verifying its `sha256`
 * when present. Third-party deps fetched over the network MUST carry a `sha256`
 * (a download with no integrity check is refused) so a swapped/corrupted artifact
 * fails loudly instead of silently testing the wrong code.
 *
 * Supported source kinds: `path` (local, optional sha256) and `url` (download +
 * required sha256). `modrinth:` is documented in ENVIRONMENTS.md but not yet a
 * field the runner consumes; use `url:` + `sha256:` until it lands.
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/** A resolvable artifact source (the subset of mc-test.yml Source the runner consumes). */
export interface ArtifactSource {
  path?: string;
  url?: string;
  sha256?: string;
  /** Install filename override (e.g. "regions.jar"). */
  as?: string;
}

/** Hex sha256 of a file. */
export function sha256File(path: string): Promise<string> {
  return new Promise((res, rej) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (d) => hash.update(d))
      .on("end", () => res(hash.digest("hex")))
      .on("error", rej);
  });
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
  throw new Error(
    "unsupported plugin/mod source: provide `path` (local jar) or `url` + `sha256`. " +
      "(modrinth: is documented but not yet a runner-consumed field — use url+sha256.)",
  );
}
