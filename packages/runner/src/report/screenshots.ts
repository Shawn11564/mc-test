/**
 * Screenshot artifact handling: decode the base64 PNG an MCTP `screen.screenshot`
 * returns, persist it under the per-test artifacts dir, and run an INFORMATIONAL,
 * non-gating baseline diff (ROADMAP §5.4 / M4). Shared by the `screenshot` STEP
 * VERB (explicit capture) and the on-failure AUTO-CAPTURE path, so both write
 * identical artifacts and record paths the HTML/JUnit reporters surface.
 *
 * Defensive by construction: `captureScreenshot` returns a result object and only
 * throws if the underlying MCTP call throws (the verb wants that to fail the
 * step); the failure-path wrapper `tryCaptureOnFailure` swallows everything so a
 * screenshot can never turn a failing test into a crash.
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { comparePng } from "./pngDiff.js";

/** The minimal session surface the capture needs (an MCTP `screen.screenshot` caller). */
export interface ScreenshotCaller {
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
}

/**
 * The two canonical inline-result shapes we accept. PROTOCOL.md §7.4 pins the
 * nested form `{ image: { format, width, height, encoding:"base64", data } }`; we
 * also tolerate the flatter `{ image: <base64>, format, encoding }` some agents/
 * mocks emit, so a real capture is never lost to a shape mismatch.
 */
interface ScreenshotResult {
  image?:
    | string
    | { format?: string; width?: number; height?: number; encoding?: string; data?: string; ref?: string };
  format?: string;
  width?: number;
  height?: number;
  encoding?: string;
  data?: string;
}

/** Extracted PNG bytes + dimensions, or null when the result carried no inline image. */
interface DecodedImage {
  png: Buffer;
  width?: number;
  height?: number;
}

/** Pull base64 PNG bytes out of either accepted result shape. Returns null for a `ref`-only result. */
function decodeImage(result: ScreenshotResult): DecodedImage | null {
  const img = result.image;
  let base64: string | undefined;
  let width: number | undefined;
  let height: number | undefined;
  if (typeof img === "string") {
    base64 = img;
    width = result.width;
    height = result.height;
  } else if (img && typeof img === "object") {
    base64 = img.data ?? (typeof result.data === "string" ? result.data : undefined);
    width = img.width ?? result.width;
    height = img.height ?? result.height;
  } else {
    // No `image` field: accept a top-level `data` base64 as a last resort.
    base64 = typeof result.data === "string" ? result.data : undefined;
    width = result.width;
    height = result.height;
  }
  if (!base64) return null; // e.g. a `ref` return mode — nothing inline to persist
  const png = Buffer.from(base64, "base64");
  if (png.length === 0) return null;
  return { png, ...(width !== undefined ? { width } : {}), ...(height !== undefined ? { height } : {}) };
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

/** Informational baseline-diff outcome (NEVER gates pass/fail). */
export interface BaselineDiff {
  /** A baseline existed and was compared (false when we just wrote the candidate). */
  compared: boolean;
  /** Path of the baseline (existing or newly-written candidate). */
  baselinePath: string;
  /** Fraction of differing pixels in [0,1], when `compared`. */
  ratio?: number;
  diffPixels?: number;
  totalPixels?: number;
  sameSize?: boolean;
  /** Set when the baseline (or capture) could not be decoded for comparison. */
  unsupported?: string;
}

/** The artifact a single screenshot produced. */
export interface ScreenshotArtifact {
  /** Absolute path of the persisted PNG. */
  path: string;
  width?: number;
  height?: number;
  /** Present when a baseline dir was configured (informational only). */
  baseline?: BaselineDiff;
}

export interface CaptureOptions {
  /** Directory the PNG is written into (created if missing). */
  artifactsDir: string;
  /** A label distinguishing this capture (verb name / "failure"); used in the filename. */
  slot: string;
  /** Optional MCTP params (region / maxWidth / format) forwarded to `screen.screenshot`. */
  params?: Record<string, unknown>;
  /**
   * Optional baseline directory. When set, an existing `<dir>/<key>.png` is diffed
   * against this capture (informational); when absent, this capture is written
   * there as the baseline candidate. `key` defaults to `slot`.
   */
  baselineDir?: string;
  baselineKey?: string;
}

/**
 * Call `screen.screenshot`, decode the inline PNG, write it to the artifacts dir,
 * and (when a baseline dir is given) record an informational diff. Returns the
 * artifact, or `null` if the result carried no inline image (e.g. a `ref` return).
 * Propagates an MCTP error from the call — the explicit `screenshot` step wants a
 * capture failure to fail the step; the failure-path uses `tryCaptureOnFailure`.
 */
export async function captureScreenshot(
  session: ScreenshotCaller,
  opts: CaptureOptions,
): Promise<ScreenshotArtifact | null> {
  const result = await session.call<ScreenshotResult>("screen.screenshot", {
    format: "png",
    return: "inline",
    ...(opts.params ?? {}),
  });
  const decoded = decodeImage(result);
  if (!decoded) return null;

  mkdirSync(opts.artifactsDir, { recursive: true });
  const fileName = `screenshot-${sanitize(opts.slot)}.png`;
  const path = join(opts.artifactsDir, fileName);
  writeFileSync(path, decoded.png);

  const artifact: ScreenshotArtifact = {
    path,
    ...(decoded.width !== undefined ? { width: decoded.width } : {}),
    ...(decoded.height !== undefined ? { height: decoded.height } : {}),
  };

  if (opts.baselineDir) {
    artifact.baseline = diffAgainstBaseline(decoded.png, opts.baselineDir, opts.baselineKey ?? opts.slot);
  }
  return artifact;
}

/**
 * Compare a freshly-captured PNG to its baseline (informational, NON-GATING). If
 * no baseline exists yet, the capture is written AS the baseline candidate and
 * `compared:false` is returned — first run seeds the baseline; later runs diff
 * against it. This never throws and never affects a test's pass/fail.
 */
export function diffAgainstBaseline(png: Buffer, baselineDir: string, key: string): BaselineDiff {
  const baselinePath = join(baselineDir, `${sanitize(key)}.png`);
  if (!existsSync(baselinePath)) {
    mkdirSync(baselineDir, { recursive: true });
    writeFileSync(baselinePath, png);
    return { compared: false, baselinePath };
  }
  const baseline = readFileSync(baselinePath);
  const cmp = comparePng(baseline, png);
  return {
    compared: true,
    baselinePath,
    ratio: cmp.ratio,
    diffPixels: cmp.diffPixels,
    totalPixels: cmp.totalPixels,
    sameSize: cmp.sameSize,
    ...(cmp.unsupported ? { unsupported: cmp.unsupported } : {}),
  };
}

/**
 * Best-effort capture for the FAILURE path: identical to `captureScreenshot` but
 * wrapped so it can NEVER throw — any error (no capability routed, the screen
 * call errors, a write fails) yields `null` and the run proceeds. This is the
 * "on failure the runner attaches it as an artifact" hook (ROADMAP §5.4),
 * deliberately silent so a screenshot problem never masks the real failure.
 */
export async function tryCaptureOnFailure(
  session: ScreenshotCaller | undefined,
  opts: CaptureOptions,
): Promise<ScreenshotArtifact | null> {
  if (!session) return null;
  try {
    return await captureScreenshot(session, opts);
  } catch {
    return null;
  }
}
