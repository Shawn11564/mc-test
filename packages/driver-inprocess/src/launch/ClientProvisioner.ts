/**
 * Provision a launchable Minecraft + Fabric client (the real F3 "ClientLauncher
 * real launch" work). This is the I/O half: it fetches Mojang's version manifest
 * + version JSON, downloads the client jar, libraries, and (optionally) the asset
 * bundle, fetches Fabric's loader profile + libraries, extracts the LWJGL natives,
 * and lays out a per-instance game dir whose `mods/` holds the SUT mod(s) + the
 * client MCTP agent jar. It returns a `ResolvedClient` the pure `ClientLauncher`
 * turns into a `java … KnotClient …` command.
 *
 * Content-addressed downloads are cached under `cacheDir` and shared across runs
 * (like the runner's `provision/jdk.ts`); only the small per-instance `mods/` is
 * rewritten each launch. `fetchImpl` is injectable so resolution is testable
 * without the network.
 */
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, copyFileSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { homedir, tmpdir } from "node:os";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  pickVersion,
  selectLibraries,
  clientJar,
  fabricLibraries,
  pickFabricLoader,
  assetDownloads,
  mojangOs,
  type VersionManifest,
  type VersionJson,
  type FabricProfile,
  type FabricLoaderEntry,
  type AssetIndexJson,
  type ResolvedArtifact,
} from "./resolve.js";
import { extractNatives } from "./unzip.js";
import type { ResolvedClient } from "./ClientLauncher.js";

const VERSION_MANIFEST_URL = "https://launchermeta.mojang.com/mc/game/version_manifest_v2.json";
const FABRIC_META = "https://meta.fabricmc.net/v2";

/** Options for provisioning a rendered client. */
export interface ProvisionOptions {
  mc: string;
  /** Loader id; only `"fabric"` is implemented for F3 (forge/neoforge are F4). */
  loader?: string;
  /** Pin a loader version for reproducibility; else the newest stable for `mc`. */
  loaderVersion?: string;
  /** SUT mod jars to drop into the instance `mods/`. */
  mods?: string[];
  /** The client MCTP agent jar (e.g. `agent-client-fabric.jar`). */
  clientAgentJar?: string;
  /** Shared content cache (client jar/libraries/assets/natives). */
  cacheDir?: string;
  /** Per-instance game dirs root (each launch gets its own `mods/`). */
  workDir?: string;
  /** Explicit instance game dir (overrides the derived one). */
  gameDir?: string;
  /** `java` to launch with (default `"java"`; MC 1.21 needs Java 21). */
  javaPath?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  /** Download the (large) asset bundle. Default `true`; `false` resolves only. */
  downloadAssets?: boolean;
  /** Parallel asset downloads (default 24). */
  concurrency?: number;
  onLog?: (line: string) => void;
  /** Injected `fetch` for tests (defaults to global `fetch`). */
  fetchImpl?: typeof fetch;
}

/** Default shared cache for provisioned client content. */
function defaultCacheDir(): string {
  return join(homedir(), ".mc-test", "cache", "clients");
}

async function fetchJson<T>(f: typeof fetch, url: string): Promise<T> {
  const res = await f(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`FETCH_FAILED: HTTP ${res.status} for ${url}`);
  return (await res.json()) as T;
}

/** Download `url` → `dest` (cached: skips if present). Streams to a temp file then renames. */
async function download(f: typeof fetch, url: string, dest: string): Promise<void> {
  if (existsSync(dest) && statSync(dest).size > 0) return; // cache hit
  mkdirSync(dirname(dest), { recursive: true });
  const res = await f(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`DOWNLOAD_FAILED: HTTP ${res.status} for ${url}`);
  const tmp = `${dest}.part`;
  await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(tmp));
  rmSync(dest, { force: true });
  // node:fs rename via copy+unlink to avoid cross-device issues is overkill here; use renameSync.
  (await import("node:fs")).renameSync(tmp, dest);
}

/** Run `fn` over `items` with bounded concurrency. */
async function pool<T>(items: T[], n: number, fn: (item: T, i: number) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    for (;;) {
      const idx = i++;
      if (idx >= items.length) return;
      const item = items[idx];
      if (item !== undefined) await fn(item, idx);
    }
  });
  await Promise.all(workers);
}

/**
 * Resolve + download everything needed to launch a Fabric client for `mc`, and
 * stage the instance `mods/`. Returns the `ResolvedClient` for `buildClientLaunch`.
 */
export async function provisionClient(opts: ProvisionOptions): Promise<ResolvedClient> {
  const f = opts.fetchImpl ?? fetch;
  const log = opts.onLog ?? (() => {});
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const loader = opts.loader ?? "fabric";
  if (loader !== "fabric") {
    throw new Error(
      `UNSUPPORTED_LOADER: the in-process client launcher implements 'fabric' (got '${loader}'). ` +
        `forge/neoforge/quilt rendered clients are F4 — that target should honest-skip.`,
    );
  }
  const cacheDir = opts.cacheDir ?? defaultCacheDir();
  const librariesDir = join(cacheDir, "libraries");
  const assetsDir = join(cacheDir, "assets");
  const versionDir = join(cacheDir, "versions", opts.mc);
  const nativesDir = join(cacheDir, "natives", `${opts.mc}-${mojangOs(platform)}-${arch}`);

  // 1) Vanilla: manifest → version JSON → client jar + libraries + asset index.
  log(`Resolving Minecraft ${opts.mc} from the Mojang manifest…`);
  const manifest = await fetchJson<VersionManifest>(f, VERSION_MANIFEST_URL);
  const versionEntry = pickVersion(manifest, opts.mc);
  const version = await fetchJson<VersionJson>(f, versionEntry.url);

  const client = clientJar(version);
  const clientJarPath = join(versionDir, "client.jar");
  const { classpath: vanillaLibs, natives } = selectLibraries(version, platform, arch);

  // 2) Fabric: loader version → profile → loader libraries + KnotClient main.
  const loaderVersion = opts.loaderVersion ?? (await resolveFabricLoader(f, opts.mc));
  log(`Resolving Fabric loader ${loaderVersion} for ${opts.mc}…`);
  const profile = await fetchJson<FabricProfile>(
    f,
    `${FABRIC_META}/versions/loader/${opts.mc}/${loaderVersion}/profile/json`,
  );
  const fabricLibs = fabricLibraries(profile);

  // 3) Download the classpath jars (vanilla client + vanilla + fabric libs).
  log(`Downloading client jar + ${vanillaLibs.length + fabricLibs.length} libraries…`);
  await download(f, client.url, clientJarPath);
  const concurrency = opts.concurrency ?? 24;
  await pool([...vanillaLibs, ...fabricLibs], concurrency, async (lib) => {
    await download(f, lib.url, join(librariesDir, lib.path));
  });

  // 4) Extract natives into the natives dir.
  log(`Extracting ${natives.length} native bundle(s)…`);
  mkdirSync(nativesDir, { recursive: true });
  for (const nat of natives) {
    const jarPath = join(librariesDir, nat.path);
    await download(f, nat.url, jarPath);
    extractNatives(readFileSync(jarPath), (name, data) => writeFileSync(join(nativesDir, name), data));
  }

  // 5) Assets (the big bundle) — index + objects, content-addressed + cached.
  let assetIndexId = version.assets ?? version.assetIndex?.id ?? "legacy";
  if (version.assetIndex?.url) {
    const indexPath = join(assetsDir, "indexes", `${assetIndexId}.json`);
    await download(f, version.assetIndex.url, indexPath);
    if (opts.downloadAssets !== false) {
      const index = JSON.parse(readFileSync(indexPath, "utf8")) as AssetIndexJson;
      const objects = assetDownloads(index);
      log(`Downloading ${objects.length} asset objects…`);
      await pool(objects, concurrency, async (obj) => {
        await download(f, obj.url, join(assetsDir, obj.path));
      });
    } else {
      log("Skipping asset object download (downloadAssets=false).");
    }
  }

  // 6) Per-instance game dir: fresh mods/ with the SUT mods + the client agent.
  const gameDir = opts.gameDir ?? join(opts.workDir ?? join(tmpdir(), "mc-test-clients"), `${loader}-${opts.mc}`);
  stageMods(gameDir, opts.mods ?? [], opts.clientAgentJar, log);

  const classpath = [
    ...fabricLibs.map((l) => join(librariesDir, l.path)),
    ...vanillaLibs.map((l) => join(librariesDir, l.path)),
    clientJarPath,
  ];

  return {
    mc: opts.mc,
    loader,
    loaderVersion,
    javaPath: opts.javaPath ?? "java",
    mainClass: profile.mainClass,
    classpath,
    nativesDir,
    gameDir,
    assetsDir,
    assetIndex: assetIndexId,
    platform,
  };
}

/** Newest stable Fabric loader version for `mc` (Fabric meta loader list). */
async function resolveFabricLoader(f: typeof fetch, mc: string): Promise<string> {
  const loaders = await fetchJson<FabricLoaderEntry[]>(f, `${FABRIC_META}/versions/loader/${mc}`);
  return pickFabricLoader(loaders);
}

/** Reset the instance `mods/` to exactly the SUT mods + the client agent jar. */
function stageMods(gameDir: string, mods: string[], agentJar: string | undefined, log: (l: string) => void): void {
  const modsDir = join(gameDir, "mods");
  mkdirSync(modsDir, { recursive: true });
  // Clear any stale jars so a re-run never carries an old mod.
  for (const entry of existsSync(modsDir) ? readdirSync(modsDir) : []) {
    if (entry.endsWith(".jar")) rmSync(join(modsDir, entry), { force: true });
  }
  const all = [...mods, ...(agentJar ? [agentJar] : [])];
  for (const src of all) {
    if (!existsSync(src)) {
      throw new Error(`MOD_JAR_MISSING: ${src} — build it before launching the rendered client`);
    }
    copyFileSync(src, join(modsDir, basename(src)));
  }
  log(`Staged ${all.length} mod jar(s) into ${modsDir}`);
}

/** Re-export for callers/tests that want the resolved shape. */
export type { ResolvedClient } from "./ClientLauncher.js";
export type { ResolvedArtifact } from "./resolve.js";
