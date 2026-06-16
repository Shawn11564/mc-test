/**
 * A tiny, dependency-free ZIP extractor — just enough to pull native libraries
 * (`.dll` / `.so` / `.dylib`) out of LWJGL `natives-*.jar` files into a flat
 * natives directory. A `.jar` is a ZIP; we read the End-Of-Central-Directory
 * record, walk the central directory, and inflate only the entries we want with
 * `node:zlib`. No third-party dependency (matches the JDK-fetch ethos in the
 * runner's `provision/jdk.ts`).
 *
 * Scope: store (method 0) and deflate (method 8), which is all a natives jar uses.
 */
import { inflateRawSync } from "node:zlib";
import { basename } from "node:path";

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

/** Find and parse the End-Of-Central-Directory record (scanning back from the end). */
function findEocd(buf: Buffer): { count: number; cenOffset: number } {
  // EOCD is 22 bytes + up to 65535 of comment; scan back for the signature.
  const minPos = Math.max(0, buf.length - (22 + 0xffff));
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      return { count: buf.readUInt16LE(i + 10), cenOffset: buf.readUInt32LE(i + 16) };
    }
  }
  throw new Error("BAD_ZIP: no End-Of-Central-Directory record");
}

/** Read all central-directory entries. */
function readCentralDirectory(buf: Buffer, count: number, cenOffset: number): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let p = cenOffset;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== CEN_SIG) break;
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localHeaderOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Extract one entry's bytes, reading the local header to find the data offset. */
function extractEntry(buf: Buffer, entry: ZipEntry): Buffer {
  const p = entry.localHeaderOffset;
  if (buf.readUInt32LE(p) !== LOC_SIG) throw new Error(`BAD_ZIP: bad local header for ${entry.name}`);
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const dataStart = p + 30 + nameLen + extraLen;
  const raw = buf.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) return inflateRawSync(raw);
  throw new Error(`UNSUPPORTED_ZIP_METHOD: ${entry.method} for ${entry.name}`);
}

const NATIVE_EXT = /\.(dll|so|dylib|jnilib)$/i;

/**
 * Extract native libraries from a `.jar`/`.zip` buffer into `destDir` (flat,
 * by basename). Skips `META-INF` and non-native files. Returns the basenames
 * written. `writeFile` is injected so the pure unzip logic stays I/O-free and
 * testable; the provisioner passes a real `fs.writeFileSync`.
 */
export function extractNatives(
  zip: Buffer,
  writeFile: (name: string, data: Buffer) => void,
): string[] {
  const { count, cenOffset } = findEocd(zip);
  const entries = readCentralDirectory(zip, count, cenOffset);
  const written: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith("META-INF/")) continue;
    if (entry.name.endsWith("/")) continue;
    const base = basename(entry.name);
    if (!NATIVE_EXT.test(base)) continue;
    writeFile(base, extractEntry(zip, entry));
    written.push(base);
  }
  return written;
}
