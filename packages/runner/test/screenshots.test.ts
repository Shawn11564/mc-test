/**
 * F3: screenshots as a real failure artifact + an informational, non-gating
 * baseline diff. Three layers, all with NO Minecraft boot:
 *  1. the pure PNG decoder + `comparePng` (identical → 0; size mismatch →
 *     sameSize:false; a known synthetic pair → expected diffPixels);
 *  2. the artifact-writing path — a mock Session returning a canned base64 PNG,
 *     captured into a temp dir, with the informational baseline diff;
 *  3. auto-capture-on-failure is best-effort — a Session whose `screen.screenshot`
 *     throws must NOT crash the run.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { deflateSync } from "node:zlib";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodePng,
  comparePng,
  isDecoded,
  captureScreenshot,
  tryCaptureOnFailure,
  collectArtifacts,
  renderJUnit,
  type ScreenshotCaller,
  type TestResult,
} from "../src/index.js";
import { renderHtml } from "../src/report/HtmlReporter.js";

// --- a minimal, valid PNG encoder for fixtures (truecolour, 8-bit) ----------

function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, crc.length ? Buffer.concat([data, crc]) : data]);
}

/**
 * Encode an RGBA pixel array (`width*height*4`) to a PNG buffer. `colorType` 6
 * (RGBA) or 2 (RGB); `filter` is fixed at 0 (None) for simplicity. Uses only
 * node:zlib — the same primitive the decoder relies on, round-tripped.
 */
function encodePng(width: number, height: number, rgba: Uint8Array, colorType: 2 | 6 = 6): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = colorType;
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace none
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const rawLen = (stride + 1) * height;
  const raw = Buffer.alloc(rawLen);
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0; // filter: None
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 4;
      raw[p++] = rgba[src]!;
      raw[p++] = rgba[src + 1]!;
      raw[p++] = rgba[src + 2]!;
      if (channels === 4) raw[p++] = rgba[src + 3]!;
    }
  }
  const idat = deflateSync(raw);
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A solid-colour RGBA buffer of the given size. */
function solid(width: number, height: number, r: number, g: number, b: number, a = 255): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    out[i * 4] = r;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    out[i * 4 + 3] = a;
  }
  return out;
}

// --- 1. pure pngDiff --------------------------------------------------------

describe("pngDiff: pure PNG decode + comparison (node built-ins only)", () => {
  it("decodes an 8-bit RGBA PNG to the right dimensions and pixels", () => {
    const png = encodePng(2, 2, solid(2, 2, 10, 20, 30), 6);
    const dec = decodePng(png);
    expect(isDecoded(dec)).toBe(true);
    if (!isDecoded(dec)) return;
    expect(dec.width).toBe(2);
    expect(dec.height).toBe(2);
    expect(dec.rgba.length).toBe(2 * 2 * 4);
    expect([dec.rgba[0], dec.rgba[1], dec.rgba[2], dec.rgba[3]]).toEqual([10, 20, 30, 255]);
  });

  it("decodes an RGB (colorType 2) PNG, forcing alpha to 255", () => {
    const png = encodePng(3, 1, solid(3, 1, 1, 2, 3), 2);
    const dec = decodePng(png);
    expect(isDecoded(dec)).toBe(true);
    if (!isDecoded(dec)) return;
    expect(dec.width).toBe(3);
    expect(dec.rgba[3]).toBe(255);
  });

  it("identical buffers → ratio 0, diffPixels 0, sameSize true", () => {
    const png = encodePng(4, 4, solid(4, 4, 100, 100, 100));
    const cmp = comparePng(png, Buffer.from(png));
    expect(cmp.sameSize).toBe(true);
    expect(cmp.diffPixels).toBe(0);
    expect(cmp.totalPixels).toBe(16);
    expect(cmp.ratio).toBe(0);
  });

  it("different sizes → sameSize false, ratio 1", () => {
    const a = encodePng(2, 2, solid(2, 2, 0, 0, 0));
    const b = encodePng(3, 3, solid(3, 3, 0, 0, 0));
    const cmp = comparePng(a, b);
    expect(cmp.sameSize).toBe(false);
    expect(cmp.ratio).toBe(1);
  });

  it("a known synthetic pair → expected diffPixels", () => {
    // Base: all black 3x1. Variant: middle pixel red → exactly 1 differing pixel.
    const base = solid(3, 1, 0, 0, 0);
    const variant = solid(3, 1, 0, 0, 0);
    variant[4] = 255; // pixel index 1, R channel
    const cmp = comparePng(encodePng(3, 1, base), encodePng(3, 1, variant));
    expect(cmp.sameSize).toBe(true);
    expect(cmp.totalPixels).toBe(3);
    expect(cmp.diffPixels).toBe(1);
    expect(cmp.ratio).toBeCloseTo(1 / 3, 6);
  });

  it("de-filters Sub / Up / Average / Paeth scanlines (real screenshots use these)", () => {
    // Hand-build a 2x2 RGBA PNG where each row uses a different filter, so the
    // decoder's per-filter reconstruction is exercised (encodePng only emits None).
    // Target image: row0 = [(10,20,30,40),(50,60,70,80)], row1 = [(11,22,33,44),(55,66,77,88)].
    const w = 2;
    const h = 2;
    const ch = 4;
    const target = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80, 11, 22, 33, 44, 55, 66, 77, 88]);
    const stride = w * ch;
    // Row 0: filter 1 (Sub) → first pixel raw, second = cur - left.
    const row0 = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) row0[x] = (target[x]! - (x >= ch ? target[x - ch]! : 0)) & 0xff;
    // Row 1: filter 2 (Up) → cur - above (row0 target values).
    const row1 = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) row1[x] = (target[stride + x]! - target[x]!) & 0xff;
    const raw = Buffer.concat([Buffer.from([1]), Buffer.from(row0), Buffer.from([2]), Buffer.from(row1)]);

    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    const png = Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);

    const dec = decodePng(png);
    expect(isDecoded(dec)).toBe(true);
    if (!isDecoded(dec)) return;
    expect(Array.from(dec.rgba)).toEqual(Array.from(target));
  });

  it("a non-PNG / undecodable buffer → unsupported, never throws", () => {
    const cmp = comparePng(Buffer.from("not a png"), encodePng(1, 1, solid(1, 1, 0, 0, 0)));
    expect(cmp.unsupported).toBeDefined();
    expect(cmp.sameSize).toBe(false);
    expect(cmp.ratio).toBe(1);
    // The decoder itself returns a reasoned unsupported result rather than throwing.
    const dec = decodePng(Buffer.from([1, 2, 3]));
    expect(isDecoded(dec)).toBe(false);
  });
});

// --- 2 & 3. the artifact-writing path + best-effort failure capture ---------

/** A mock Session that returns a canned base64 PNG (canonical nested shape). */
function pngSession(png: Buffer, recorder?: string[]): ScreenshotCaller {
  return {
    async call<T>(method: string): Promise<T> {
      recorder?.push(method);
      if (method === "screen.screenshot") {
        return {
          ok: true,
          image: { format: "png", width: 4, height: 4, encoding: "base64", data: png.toString("base64") },
        } as T;
      }
      return { ok: true } as T;
    },
  };
}

/** A mock Session whose screen.screenshot always throws (the best-effort proof). */
function throwingSession(recorder?: string[]): ScreenshotCaller {
  return {
    async call<T>(method: string): Promise<T> {
      recorder?.push(method);
      if (method === "screen.screenshot") throw new Error("boom: no framebuffer");
      return { ok: true } as T;
    },
  };
}

describe("screenshot artifact path: capture + persist + informational baseline", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mctest-shot-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("captureScreenshot writes the decoded PNG to the artifacts dir and reports dimensions", async () => {
    const png = encodePng(4, 4, solid(4, 4, 50, 60, 70));
    const artifactsDir = join(dir, "artifacts");
    const artifact = await captureScreenshot(pngSession(png), { artifactsDir, slot: "step" });

    expect(artifact).not.toBeNull();
    expect(artifact!.width).toBe(4);
    expect(artifact!.height).toBe(4);
    expect(existsSync(artifact!.path)).toBe(true);
    // The persisted bytes round-trip back to the same image.
    const written = readFileSync(artifact!.path);
    expect(comparePng(written, png).diffPixels).toBe(0);
  });

  it("accepts the flatter { image:<base64> } result shape (mock-agent compatible)", async () => {
    const png = encodePng(2, 2, solid(2, 2, 9, 9, 9));
    const flat: ScreenshotCaller = {
      async call<T>(): Promise<T> {
        return { ok: true, format: "png", encoding: "base64", image: png.toString("base64") } as T;
      },
    };
    const artifact = await captureScreenshot(flat, { artifactsDir: join(dir, "a"), slot: "flat" });
    expect(artifact).not.toBeNull();
    expect(existsSync(artifact!.path)).toBe(true);
  });

  it("baseline diff: seeds on first run, then compares (informational ratio)", async () => {
    const png = encodePng(4, 4, solid(4, 4, 50, 60, 70));
    const artifactsDir = join(dir, "artifacts");
    const baselineDir = join(dir, "baselines");

    // First run: no baseline yet → it is seeded, compared:false.
    const first = await captureScreenshot(pngSession(png), { artifactsDir, slot: "shot", baselineDir });
    expect(first!.baseline?.compared).toBe(false);
    expect(existsSync(first!.baseline!.baselinePath)).toBe(true);

    // Second run, IDENTICAL frame → compared, ratio 0.
    const second = await captureScreenshot(pngSession(png), { artifactsDir, slot: "shot", baselineDir });
    expect(second!.baseline?.compared).toBe(true);
    expect(second!.baseline?.ratio).toBe(0);

    // Third run, a CHANGED frame → still passes (informational), ratio > 0.
    const changed = solid(4, 4, 50, 60, 70);
    changed[0] = 200; // flip one pixel
    const third = await captureScreenshot(pngSession(encodePng(4, 4, changed)), {
      artifactsDir,
      slot: "shot",
      baselineDir,
    });
    expect(third!.baseline?.compared).toBe(true);
    expect(third!.baseline!.ratio!).toBeGreaterThan(0);
  });

  it("a ref-only result (no inline image) yields null, not a crash", async () => {
    const refSession: ScreenshotCaller = {
      async call<T>(): Promise<T> {
        return { ok: true, image: { format: "png", width: 8, height: 8, ref: "artifact://s/shot.png" } } as T;
      },
    };
    const artifact = await captureScreenshot(refSession, { artifactsDir: join(dir, "x"), slot: "ref" });
    expect(artifact).toBeNull();
  });

  it("tryCaptureOnFailure is best-effort: a throwing screen.screenshot returns null, never throws", async () => {
    const calls: string[] = [];
    const artifactsDir = join(dir, "artifacts");
    const artifact = await tryCaptureOnFailure(throwingSession(calls), { artifactsDir, slot: "failure" });
    expect(artifact).toBeNull();
    expect(calls).toContain("screen.screenshot");
    // Nothing was written.
    expect(existsSync(artifactsDir) ? readdirSync(artifactsDir) : []).toEqual([]);
  });

  it("tryCaptureOnFailure with no session (no screenshot route) returns null silently", async () => {
    const artifact = await tryCaptureOnFailure(undefined, { artifactsDir: join(dir, "n"), slot: "failure" });
    expect(artifact).toBeNull();
  });
});

// --- 4. reporters surface the artifacts + the informational baseline diff ----

function resultWithShot(artifactPath: string, outcome: TestResult["outcome"] = "passed"): TestResult {
  return {
    name: "shot-test",
    target: "fabric-1.21-client",
    loader: "fabric",
    mc: "1.21.1",
    driver: "inprocess",
    outcome,
    durationMs: 10,
    steps: [
      {
        index: 0,
        verb: "screenshot",
        outcome: "passed",
        durationMs: 5,
        detail: `screenshot → ${artifactPath}`,
        artifacts: [artifactPath],
        baselineDiff: {
          baselinePath: "b.png",
          compared: true,
          ratio: 0.25,
          diffPixels: 4,
          totalPixels: 16,
          sameSize: true,
        },
      },
    ],
    artifacts: [artifactPath],
    ...(outcome === "failed" ? { failure: { message: "boom", type: "Error" }, systemOut: "trace" } : {}),
  };
}

describe("reporters surface screenshot artifacts + informational baseline diff", () => {
  it("HTML report links the screenshot file and prints the baseline ratio", () => {
    const html = renderHtml([resultWithShot("artifacts/fabric-1.21-client/shot-test/screenshot-step.png")]);
    expect(html).toContain("screenshot-step.png");
    expect(html).toContain("baseline diff: 25.00%");
  });

  it("JUnit report emits artifact + baselineDiff properties", () => {
    const xml = renderJUnit([resultWithShot("/tmp/out/artifacts/x/screenshot-step.png")]);
    expect(xml).toContain('name="artifact.0"');
    expect(xml).toContain("screenshot-step.png");
    expect(xml).toContain('name="baselineDiff.step0"');
    expect(xml).toContain('value="0.250000"');
  });
});

describe("collectArtifacts: bundles screenshots + external logs", () => {
  let out: string;
  beforeEach(() => {
    out = mkdtempSync(join(tmpdir(), "mctest-collect-"));
  });
  afterEach(() => rmSync(out, { recursive: true, force: true }));

  it("leaves in-bundle screenshots in place and copies an external log on failure", () => {
    // A screenshot the run already wrote INTO the per-test artifacts dir.
    const bundleDir = join(out, "artifacts", "fabric-1.21-client", "shot-test");
    mkdirSync(bundleDir, { recursive: true });
    const shot = join(bundleDir, "screenshot-step.png");
    writeFileSync(shot, encodePng(1, 1, solid(1, 1, 0, 0, 0)));
    // A server log living elsewhere (outside the bundle).
    const logPath = join(out, "server.log");
    writeFileSync(logPath, "server boot log");

    const result = resultWithShot(shot, "failed");
    result.artifacts = [shot, logPath];
    const bundle = collectArtifacts(out, result);

    // The in-bundle screenshot is reported in place (not duplicated/copied onto itself).
    expect(bundle.files).toContain(shot);
    // The external log was copied INTO the bundle dir.
    const copiedLog = join(bundleDir, "server.log");
    expect(existsSync(copiedLog)).toBe(true);
    expect(bundle.files).toContain(copiedLog);
    // A steps.txt trace is written on failure.
    expect(bundle.files.some((f) => f.endsWith("steps.txt"))).toBe(true);
  });

  it("collects a passing test's screenshot artifacts too (not only on failure)", () => {
    const bundleDir = join(out, "artifacts", "fabric-1.21-client", "shot-test");
    mkdirSync(bundleDir, { recursive: true });
    const shot = join(bundleDir, "screenshot-step.png");
    writeFileSync(shot, encodePng(1, 1, solid(1, 1, 0, 0, 0)));
    const result = resultWithShot(shot, "passed");
    const bundle = collectArtifacts(out, result);
    expect(bundle.files).toContain(shot);
    // No steps.txt on a pass.
    expect(bundle.files.some((f) => f.endsWith("steps.txt"))).toBe(false);
  });
});
