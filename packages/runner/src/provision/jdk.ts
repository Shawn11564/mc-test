/**
 * Multi-JDK provisioning (v2 — the F2 real-boot enabler).
 *
 * Different Minecraft versions require different Java majors, and a host JDK is often the
 * WRONG one: a machine on Java 21 cannot boot a legacy 1.8.x server (which needs Java 8).
 * This module maps an `mc` version to an acceptable Java range and resolves a matching JDK:
 *   1. the host `java`, when it already satisfies the range (fastest — modern targets are
 *      unchanged and download nothing);
 *   2. an explicitly configured JDK (`provision.jdks[<major>]`) or `JDK<major>_HOME` env;
 *   3. a previously-fetched JDK in the cache;
 *   4. an Eclipse Temurin build fetched from the Adoptium API into the cache and extracted.
 *
 * It returns the path to a `java` executable for the provisioner to spawn (`javaPath`).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, createWriteStream } from "node:fs";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/** The inclusive Java-major range a Minecraft version boots on. `max` 99 = no practical ceiling. */
export interface JavaRange {
  min: number;
  max: number;
}

/** Options for resolving a JDK (injectable bits keep it unit-testable without network/JVM). */
export interface JdkResolveOptions {
  cacheDir: string;
  /** Explicit JDK homes keyed by major version string, e.g. `{ "8": "C:/jdk8" }`. */
  configured?: Record<string, string>;
  /** Fetch a Temurin JDK from Adoptium when none is configured/installed. Default `true`. */
  download?: boolean;
  /** Override platform (defaults to `process.platform`). */
  platform?: NodeJS.Platform;
  /** Override arch (defaults to `process.arch`). */
  arch?: string;
  /** Inject the host `java` major instead of probing it (for tests). */
  hostJavaMajor?: number;
  onLog?: (line: string) => void;
}

function parseMcVersion(mc: string): [number, number, number] {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(mc.trim());
  if (!m) return [0, 0, 0];
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
}

function cmp(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * The Java majors a given `mc` boots on (Mojang's server requirements + the practical upper
 * bound where newer Java removed APIs the version relies on):
 *   ≤ 1.16.5 → 8–11 · 1.17.x → 16–17 · 1.18–1.20.4 → 17+ · ≥ 1.20.5 → 21+.
 */
export function acceptableJavaRange(mc: string): JavaRange {
  const v = parseMcVersion(mc);
  if (cmp(v, [1, 20, 5]) >= 0) return { min: 21, max: 99 };
  if (cmp(v, [1, 18, 0]) >= 0) return { min: 17, max: 99 };
  if (cmp(v, [1, 17, 0]) >= 0) return { min: 16, max: 17 };
  return { min: 8, max: 11 };
}

/**
 * The Java major to FETCH for a version when the host doesn't fit — always an LTS that Adoptium
 * publishes and that boots the version: ≤ 1.16.5 → 8 · 1.17–1.20.4 → 17 · ≥ 1.20.5 → 21. (Note this
 * can differ from `acceptableJavaRange().min`: a locally-installed Java 16 also boots 1.17, but only
 * LTS 17 is reliably fetchable, so 17 is what we download.)
 */
export function requiredJavaMajor(mc: string): number {
  const v = parseMcVersion(mc);
  if (cmp(v, [1, 20, 5]) >= 0) return 21;
  if (cmp(v, [1, 17, 0]) >= 0) return 17;
  return 8;
}

/** Parse a Java major (8, 11, 17, 21…) from `java -version` output, or undefined. */
export function parseJavaVersionMajor(versionOutput: string): number | undefined {
  const m = /version "(\d+)(?:\.(\d+))?[._\d]*"/.exec(versionOutput);
  if (!m) return undefined;
  const first = Number(m[1]);
  // Legacy scheme `1.8.0` → 8; modern scheme `17.0.10` → 17.
  return first === 1 ? (m[2] ? Number(m[2]) : undefined) : first;
}

/** The `java` executable inside a JDK home, per platform. */
export function javaBin(home: string, platform: NodeJS.Platform = process.platform): string {
  return join(home, "bin", platform === "win32" ? "java.exe" : "java");
}

/** Run `java -version` and read its major, or undefined if it cannot be probed. */
export function javaMajorOf(javaExe: string): number | undefined {
  try {
    const r = spawnSync(javaExe, ["-version"], { encoding: "utf8" });
    return parseJavaVersionMajor(`${r.stdout ?? ""}${r.stderr ?? ""}`);
  } catch {
    return undefined;
  }
}

/** Find a previously-extracted JDK of `major` under `<cacheDir>/jdks/<major>/`, or undefined. */
function cachedJdkExe(cacheDir: string, major: number, platform: NodeJS.Platform): string | undefined {
  const root = join(cacheDir, "jdks", String(major));
  if (!existsSync(root)) return undefined;
  for (const entry of readdirSync(root)) {
    const exe = javaBin(join(root, entry), platform);
    if (existsSync(exe)) return exe;
    // macOS Temurin nests the runtime under Contents/Home.
    const macExe = join(root, entry, "Contents", "Home", "bin", "java");
    if (existsSync(macExe)) return macExe;
  }
  return undefined;
}

function extractArchive(archivePath: string, dest: string, platform: NodeJS.Platform): void {
  // bsdtar (Win10 1803+) and GNU/BSD tar all auto-detect .zip / .tar.gz with `-xf`.
  const r = spawnSync("tar", ["-xf", archivePath, "-C", dest], { encoding: "utf8" });
  if (r.status === 0) return;
  if (platform === "win32" && archivePath.endsWith(".zip")) {
    const ps = spawnSync(
      "powershell",
      ["-NoProfile", "-Command", `Expand-Archive -Force -LiteralPath '${archivePath}' -DestinationPath '${dest}'`],
      { encoding: "utf8" },
    );
    if (ps.status === 0) return;
    throw new Error(`JDK_EXTRACT_FAILED: tar and Expand-Archive both failed for ${archivePath}`);
  }
  throw new Error(`JDK_EXTRACT_FAILED: tar -xf ${archivePath} (status ${r.status}): ${r.stderr ?? ""}`);
}

/** Download + extract an Eclipse Temurin JDK of `major` into the cache; return its `java`. */
export async function fetchTemurin(
  major: number,
  cacheDir: string,
  platform: NodeJS.Platform,
  arch: string,
  onLog: (line: string) => void,
): Promise<string> {
  const os = platform === "win32" ? "windows" : platform === "darwin" ? "mac" : "linux";
  const a = arch === "arm64" ? "aarch64" : "x64";
  const dest = join(cacheDir, "jdks", String(major));
  mkdirSync(dest, { recursive: true });
  const url = `https://api.adoptium.net/v3/binary/latest/${major}/ga/${os}/${a}/jdk/hotspot/normal/eclipse`;
  onLog(`Fetching Eclipse Temurin JDK ${major} (${os}/${a}) from Adoptium…`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`JDK_DOWNLOAD_FAILED: HTTP ${res.status} for Temurin ${major} (${os}/${a})`);
  }
  const archivePath = join(dest, `temurin-${major}.${os === "windows" ? "zip" : "tar.gz"}`);
  await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(archivePath));
  extractArchive(archivePath, dest, platform);
  const exe = cachedJdkExe(cacheDir, major, platform);
  if (!exe) throw new Error(`JDK_EXTRACT_FAILED: no java binary under ${dest} after extracting ${archivePath}`);
  onLog(`Temurin JDK ${major} ready: ${exe}`);
  return exe;
}

/** Resolve a JDK of EXACTLY `major`: configured → env → cache → fetched. */
export async function resolveJdk(major: number, opts: JdkResolveOptions): Promise<string> {
  const platform = opts.platform ?? process.platform;
  const onLog = opts.onLog ?? (() => {});
  const cfg = opts.configured?.[String(major)];
  if (cfg) {
    const exe = javaBin(resolve(cfg), platform);
    if (existsSync(exe)) return exe;
    throw new Error(`JDK_NOT_AVAILABLE: configured jdks.${major} has no java at ${exe}`);
  }
  for (const key of [`JDK${major}_HOME`, `JAVA${major}_HOME`]) {
    const home = process.env[key];
    if (home) {
      const exe = javaBin(resolve(home), platform);
      if (existsSync(exe)) return exe;
    }
  }
  const cached = cachedJdkExe(opts.cacheDir, major, platform);
  if (cached) return cached;
  if (opts.download !== false) {
    return fetchTemurin(major, opts.cacheDir, platform, opts.arch ?? process.arch, onLog);
  }
  throw new Error(
    `JDK_NOT_AVAILABLE: need Java ${major} but none configured/installed and download is disabled. ` +
      `Set provision.jdks.${major} or JDK${major}_HOME, or enable provision.downloadJdks.`,
  );
}

/**
 * Resolve a `java` executable that can boot Minecraft `mc`. Prefers the host JDK when it is in
 * range (so modern targets boot exactly as before with no download); otherwise selects/fetches a
 * JDK whose major fits the version's acceptable range.
 */
export async function resolveJavaForMc(mc: string, opts: JdkResolveOptions): Promise<string> {
  const range = acceptableJavaRange(mc);
  const hostMajor = opts.hostJavaMajor ?? javaMajorOf("java");
  if (hostMajor !== undefined && hostMajor >= range.min && hostMajor <= range.max) {
    return "java";
  }
  return resolveJdk(requiredJavaMajor(mc), opts);
}
