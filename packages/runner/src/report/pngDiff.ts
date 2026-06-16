/**
 * A dependency-free PNG decoder + pixel-diff, used to wire an INFORMATIONAL,
 * non-gating baseline screenshot diff (ROADMAP §5.4 / M4: "a baseline screenshot
 * diff is wired (informational, not gating)"). Minecraft screenshots are 8-bit
 * truecolour PNGs (RGB or RGBA), so we decode exactly those; any other colour
 * type / bit depth returns a clear `unsupported` result rather than throwing.
 *
 * Pure data + node built-ins only (`node:zlib` for the IDAT inflate). NO new npm
 * dependency, NO game/JVM coupling — it belongs to the same pure-utility tier as
 * the rest of `@mc-test/protocol`-adjacent report helpers.
 */
import { inflateSync } from "node:zlib";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A decoded PNG: width/height + tightly-packed 8-bit RGBA pixels (4 bytes/px). */
export interface DecodedPng {
  width: number;
  height: number;
  /** RGBA, row-major, `width*height*4` bytes (alpha forced to 255 for RGB sources). */
  rgba: Uint8Array;
}

/** Why a decode could not produce RGBA pixels (never thrown — returned). */
export interface UnsupportedPng {
  unsupported: true;
  reason: string;
}

export type DecodeResult = DecodedPng | UnsupportedPng;

/** Type guard: did `decodePng` yield pixels (vs. an `unsupported` reason)? */
export function isDecoded(r: DecodeResult): r is DecodedPng {
  return (r as UnsupportedPng).unsupported !== true;
}

function hasPngSignature(buf: Buffer): boolean {
  if (buf.length < 8) return false;
  for (let i = 0; i < 8; i++) if (buf[i] !== PNG_SIGNATURE[i]) return false;
  return true;
}

/** Paeth predictor (PNG filter type 4). */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Decode a PNG buffer to RGBA. Supports the only encoding Minecraft emits: 8-bit
 * truecolour, colour type 2 (RGB) or 6 (RGBA), non-interlaced. Anything else —
 * palette, greyscale, 16-bit, Adam7 interlace — returns `{ unsupported, reason }`
 * so a caller can record "unsupported" rather than crash a run.
 */
export function decodePng(buf: Buffer): DecodeResult {
  if (!hasPngSignature(buf)) return { unsupported: true, reason: "not a PNG (bad signature)" };

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = 0;
  let sawIHDR = false;
  const idatChunks: Buffer[] = [];

  // Walk the chunk stream: 4-byte length, 4-byte type, <length> data, 4-byte CRC.
  let offset = 8;
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buf.length) return { unsupported: true, reason: `truncated chunk '${type}'` };

    if (type === "IHDR") {
      width = buf.readUInt32BE(dataStart);
      height = buf.readUInt32BE(dataStart + 4);
      bitDepth = buf[dataStart + 8]!;
      colorType = buf[dataStart + 9]!;
      interlace = buf[dataStart + 12]!;
      sawIHDR = true;
    } else if (type === "IDAT") {
      idatChunks.push(buf.subarray(dataStart, dataEnd));
    } else if (type === "IEND") {
      break;
    }
    offset = dataEnd + 4; // skip CRC
  }

  if (!sawIHDR) return { unsupported: true, reason: "missing IHDR" };
  if (width <= 0 || height <= 0) return { unsupported: true, reason: `invalid dimensions ${width}x${height}` };
  if (interlace !== 0) return { unsupported: true, reason: "interlaced PNG (Adam7) not supported" };
  if (bitDepth !== 8) return { unsupported: true, reason: `unsupported bit depth ${bitDepth} (only 8 supported)` };
  if (colorType !== 2 && colorType !== 6) {
    return { unsupported: true, reason: `unsupported color type ${colorType} (only 2=RGB / 6=RGBA supported)` };
  }
  if (idatChunks.length === 0) return { unsupported: true, reason: "no IDAT data" };

  const channels = colorType === 6 ? 4 : 3;
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idatChunks));
  } catch (err) {
    return { unsupported: true, reason: `IDAT inflate failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  const stride = width * channels; // bytes per scanline (excluding the filter byte)
  const expected = (stride + 1) * height;
  if (raw.length < expected) {
    return { unsupported: true, reason: `inflated size ${raw.length} < expected ${expected}` };
  }

  // De-filter scanlines in place into `cur`, copying each finished row to RGBA out.
  const rgba = new Uint8Array(width * height * 4);
  const prev = new Uint8Array(stride);
  const cur = new Uint8Array(stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++]!;
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[pos + x]!;
      const a = x >= channels ? cur[x - channels]! : 0; // byte to the left
      const b = prev[x]!; // byte above
      const c = x >= channels ? prev[x - channels]! : 0; // byte upper-left
      let value: number;
      switch (filter) {
        case 0:
          value = rawByte;
          break;
        case 1:
          value = rawByte + a;
          break;
        case 2:
          value = rawByte + b;
          break;
        case 3:
          value = rawByte + ((a + b) >> 1);
          break;
        case 4:
          value = rawByte + paeth(a, b, c);
          break;
        default:
          return { unsupported: true, reason: `unsupported scanline filter ${filter}` };
      }
      cur[x] = value & 0xff;
    }
    pos += stride;

    // Expand this scanline (RGB or RGBA) into the RGBA output.
    const rowBase = y * width * 4;
    for (let x = 0; x < width; x++) {
      const src = x * channels;
      const dst = rowBase + x * 4;
      rgba[dst] = cur[src]!;
      rgba[dst + 1] = cur[src + 1]!;
      rgba[dst + 2] = cur[src + 2]!;
      rgba[dst + 3] = channels === 4 ? cur[src + 3]! : 255;
    }
    prev.set(cur);
  }

  return { width, height, rgba };
}

/** The outcome of comparing two PNGs pixel-for-pixel. */
export interface PngComparison {
  /** Both decoded AND identical dimensions. */
  sameSize: boolean;
  /** Width/height of the comparison (the first image's, when sizes differ). */
  width: number;
  height: number;
  /** Count of pixels that differ (any RGBA channel). 0 when identical. */
  diffPixels: number;
  /** Total pixels compared (`width*height` of the overlap, 0 if not comparable). */
  totalPixels: number;
  /** `diffPixels / totalPixels` in [0,1]; 0 when identical, 1 when sizes differ / undecodable. */
  ratio: number;
  /** Set when either buffer could not be decoded (then `ratio` is 1, `sameSize` false). */
  unsupported?: string;
}

/**
 * Compare two PNG buffers and report how many pixels differ. Decodes both with
 * `decodePng`; if either is undecodable the result is `{ sameSize:false,
 * ratio:1, unsupported:<reason> }` (a clear signal, never a throw). When the
 * dimensions differ the images are deemed maximally different (`sameSize:false,
 * ratio:1`) — a size change IS a visual change. Identical buffers → `ratio:0`.
 */
export function comparePng(a: Buffer, b: Buffer): PngComparison {
  const da = decodePng(a);
  const db = decodePng(b);
  if (!isDecoded(da) || !isDecoded(db)) {
    const reason = !isDecoded(da) ? `a: ${da.reason}` : `b: ${(db as UnsupportedPng).reason}`;
    return { sameSize: false, width: 0, height: 0, diffPixels: 0, totalPixels: 0, ratio: 1, unsupported: reason };
  }

  if (da.width !== db.width || da.height !== db.height) {
    return {
      sameSize: false,
      width: da.width,
      height: da.height,
      diffPixels: da.width * da.height,
      totalPixels: da.width * da.height,
      ratio: 1,
    };
  }

  const totalPixels = da.width * da.height;
  let diffPixels = 0;
  const A = da.rgba;
  const B = db.rgba;
  for (let i = 0; i < totalPixels; i++) {
    const o = i * 4;
    if (A[o] !== B[o] || A[o + 1] !== B[o + 1] || A[o + 2] !== B[o + 2] || A[o + 3] !== B[o + 3]) {
      diffPixels++;
    }
  }

  return {
    sameSize: true,
    width: da.width,
    height: da.height,
    diffPixels,
    totalPixels,
    ratio: totalPixels === 0 ? 0 : diffPixels / totalPixels,
  };
}
