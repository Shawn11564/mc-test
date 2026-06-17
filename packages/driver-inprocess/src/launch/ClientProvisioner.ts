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
import {
  isFabricLike,
  isModularLoader,
  loaderInstallerArtifact,
  mergeLaunchProfile,
  flattenArguments,
  substituteArgs,
  launchVars,
  type LoaderProfileJson,
} from "./loaders.js";
import { extractNatives } from "./unzip.js";
import type { ResolvedClient, LaunchProfile } from "./ClientLauncher.js";

const VERSION_MANIFEST_URL = "https://launchermeta.mojang.com/mc/game/version_manifest_v2.json";
const FABRIC_META = "https://meta.fabricmc.net/v2";

/** Inputs a modular-loader installer run needs (Forge/NeoForge — CI-gated). */
export interface RunInstallerInput {
  loader: "forge" | "neoforge";
  mc: string;
  loaderVersion: string;
  /** Where the installer should place loader libraries (the shared cache). */
  librariesDir: string;
  cacheDir: string;
  javaPath: string;
  fetchImpl: typeof fetch;
  onLog: (line: string) => void;
}

/** Options for provisioning a rendered client. */
export interface ProvisionOptions {
  mc: string;
  /**
   * Loader id. `fabric`/`quilt` use the simple KnotClient classpath launch (F3,
   * fully implemented). `forge`/`neoforge` use the modular installer launch (F4):
   * implemented + pure parts tested, the live installer run is CI-gated behind
   * `experimentalLoaders`/`MC_TEST_RENDERED_LOADERS` (else an honest skip).
   */
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
  /**
   * Modular loaders (forge/neoforge) to ACTUALLY launch (run the installer +
   * boot). Defaults to `MC_TEST_RENDERED_LOADERS` (comma-separated). A modular
   * loader NOT listed here honest-skips (`UNSUPPORTED_TARGET`) instead of running
   * — so the local/fast-CI path never boots a forge/neoforge client it can't, and
   * never fakes a green. The multi-loader CI lane opts in on a GL-capable host.
   */
  experimentalLoaders?: string[];
  /**
   * Test/CI seam for the CI-gated modular installer run. Defaults to a real
   * best-effort runner (`defaultRunInstaller`). Injected in unit tests to return a
   * fixture launcher profile with no JVM/network.
   */
  runInstaller?: (input: RunInstallerInput) => Promise<LoaderProfileJson>;
}

/** Loaders opted into a live launch via `MC_TEST_RENDERED_LOADERS` (comma list). */
function envRenderedLoaders(): string[] {
  return (process.env["MC_TEST_RENDERED_LOADERS"] ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
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
  const loader = (opts.loader ?? "fabric").toLowerCase();
  const cacheDir = opts.cacheDir ?? defaultCacheDir();
  const librariesDir = join(cacheDir, "libraries");
  const assetsDir = join(cacheDir, "assets");
  const versionDir = join(cacheDir, "versions", opts.mc);
  const nativesDir = join(cacheDir, "natives", `${opts.mc}-${mojangOs(platform)}-${arch}`);
  const javaPath = opts.javaPath ?? "java";
  const sep = platform === "win32" ? ";" : ":";
  const os = mojangOs(platform);

  // 1) Vanilla: manifest → version JSON → client jar + libraries + asset index.
  log(`Resolving Minecraft ${opts.mc} from the Mojang manifest…`);
  const manifest = await fetchJson<VersionManifest>(f, VERSION_MANIFEST_URL);
  const versionEntry = pickVersion(manifest, opts.mc);
  const version = await fetchJson<VersionJson>(f, versionEntry.url);
  const client = clientJar(version);
  const clientJarPath = join(versionDir, "client.jar");

  // 2) Loader resolution → the classpath, the main class, the libs to download,
  //    the natives, and (modular loaders only) the BootstrapLauncher launch profile.
  const resolved = isFabricLike(loader)
    ? resolveFabricLaunch(f, opts, version, librariesDir, clientJarPath, platform, arch, log)
    : isModularLoader(loader)
      ? resolveModularLaunch(loader as "forge" | "neoforge", opts, version, {
          librariesDir,
          clientJarPath,
          nativesDir,
          assetsDir,
          cacheDir,
          javaPath,
          sep,
          os,
          platform,
          arch,
          fetchImpl: f,
          log,
        })
      : Promise.reject(
          new Error(
            `UNSUPPORTED_TARGET: the in-process client launcher supports fabric/quilt/forge/neoforge ` +
              `(got '${loader}'). Honest-skip — see docs/DRIVERS.md.`,
          ),
        );
  const { loaderVersion, mainClass, classpath, downloadLibs, natives, launchProfile } = await resolved;

  // 3) Download the classpath jars (vanilla client + the loader's libraries).
  log(`Downloading client jar + ${downloadLibs.length} libraries…`);
  await download(f, client.url, clientJarPath);
  const concurrency = opts.concurrency ?? 24;
  await pool(downloadLibs, concurrency, async (lib) => {
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
  const assetIndexId = version.assets ?? version.assetIndex?.id ?? "legacy";
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

  // 6) Per-instance game dir: fresh mods/ with the SUT mods + the client agent (+ Fabric API on
  //    Fabric/Quilt, since both the agent and the SUT mods hard-depend on it).
  const gameDir = opts.gameDir ?? join(opts.workDir ?? join(tmpdir(), "mc-test-clients"), `${loader}-${opts.mc}`);
  const runtimeMods = [...(opts.mods ?? [])];
  if (isFabricLike(loader)) {
    const apiJar = await resolveFabricApiJar(f, opts.mc, cacheDir, log);
    if (apiJar) runtimeMods.push(apiJar);
  }
  stageMods(gameDir, runtimeMods, opts.clientAgentJar, log);

  return {
    mc: opts.mc,
    loader,
    loaderVersion,
    javaPath,
    mainClass,
    classpath,
    nativesDir,
    gameDir,
    assetsDir,
    assetIndex: assetIndexId,
    platform,
    ...(launchProfile ? { launchProfile } : {}),
  };
}

/** What a loader resolver contributes on top of the shared vanilla resolution. */
interface ResolvedLaunch {
  loaderVersion: string;
  mainClass: string;
  /** Absolute classpath entries to launch with. */
  classpath: string[];
  /** Library artifacts to download into `librariesDir`. */
  downloadLibs: ResolvedArtifact[];
  /** Native bundles to download + extract. */
  natives: ResolvedArtifact[];
  /** Modular loaders only: the BootstrapLauncher JVM + game args. */
  launchProfile?: LaunchProfile;
}

/** FABRIC / Quilt (F3): loader profile → KnotClient + maven libraries. */
async function resolveFabricLaunch(
  f: typeof fetch,
  opts: ProvisionOptions,
  version: VersionJson,
  librariesDir: string,
  clientJarPath: string,
  platform: NodeJS.Platform,
  arch: string,
  log: (l: string) => void,
): Promise<ResolvedLaunch> {
  const { classpath: vanillaLibs, natives } = selectLibraries(version, platform, arch);
  const loaderVersion = opts.loaderVersion ?? (await resolveFabricLoader(f, opts.mc));
  log(`Resolving Fabric loader ${loaderVersion} for ${opts.mc}…`);
  const profile = await fetchJson<FabricProfile>(
    f,
    `${FABRIC_META}/versions/loader/${opts.mc}/${loaderVersion}/profile/json`,
  );
  const fabricLibs = fabricLibraries(profile);
  return {
    loaderVersion,
    mainClass: profile.mainClass,
    classpath: [
      ...fabricLibs.map((l) => join(librariesDir, l.path)),
      ...vanillaLibs.map((l) => join(librariesDir, l.path)),
      clientJarPath,
    ],
    downloadLibs: [...vanillaLibs, ...fabricLibs],
    natives,
  };
}

/** Context the modular resolver needs (paths + the launch-var inputs). */
interface ModularCtx {
  librariesDir: string;
  clientJarPath: string;
  nativesDir: string;
  assetsDir: string;
  cacheDir: string;
  javaPath: string;
  sep: string;
  os: ReturnType<typeof mojangOs>;
  platform: NodeJS.Platform;
  arch: string;
  fetchImpl: typeof fetch;
  log: (l: string) => void;
}

/**
 * FORGE / NeoForge (F4): the modular installer launch. Unless the loader is opted
 * in (`experimentalLoaders` / `MC_TEST_RENDERED_LOADERS`), HONEST-SKIP with a
 * precise reason — the live launch needs the loader installer to run on a
 * GL-capable host (CI-gated), so locally/fast-CI we skip rather than crash or fake.
 * When opted in: run the installer → merge its profile onto vanilla → resolve the
 * classpath + substitute the launch args. The pure parts (merge/flatten/substitute)
 * are unit-tested; the installer run is the CI-gated seam.
 */
async function resolveModularLaunch(
  loader: "forge" | "neoforge",
  opts: ProvisionOptions,
  version: VersionJson,
  ctx: ModularCtx,
): Promise<ResolvedLaunch> {
  const optedIn = (opts.experimentalLoaders ?? envRenderedLoaders()).includes(loader);
  if (!optedIn) {
    const installer = loaderInstallerArtifact(loader, opts.mc, opts.loaderVersion ?? "latest");
    throw new Error(
      `UNSUPPORTED_TARGET: ${loader} rendered-client launch is CI-gated — it needs the ${loader} ` +
        `installer to run on a GL-capable host (resolved installer: ${installer.url}). Enable on a ` +
        `capable runner with MC_TEST_RENDERED_LOADERS=${loader}. Honest-skip — see docs/DRIVERS.md.`,
    );
  }
  if (!opts.loaderVersion) {
    throw new Error(
      `INVALID_PARAMS: ${loader} needs an explicit loaderVersion (e.g. forge "47.2.0", neoforge "21.1.66").`,
    );
  }
  const runInstaller = opts.runInstaller ?? defaultRunInstaller;
  ctx.log(`Running ${loader} installer ${opts.loaderVersion} for ${opts.mc} (CI-gated)…`);
  const profile = await runInstaller({
    loader,
    mc: opts.mc,
    loaderVersion: opts.loaderVersion,
    librariesDir: ctx.librariesDir,
    cacheDir: ctx.cacheDir,
    javaPath: ctx.javaPath,
    fetchImpl: ctx.fetchImpl,
    onLog: ctx.log,
  });
  const merged = mergeLaunchProfile(version, profile);
  const { classpath: allLibs, natives } = selectLibraries(
    { ...version, libraries: merged.libraries },
    ctx.platform,
    ctx.arch,
  );
  const classpath = [...allLibs.map((l) => join(ctx.librariesDir, l.path)), ctx.clientJarPath];
  const gameDir = opts.gameDir ?? join(opts.workDir ?? join(tmpdir(), "mc-test-clients"), `${loader}-${opts.mc}`);
  const vars = launchVars({
    librariesDir: ctx.librariesDir,
    classpathSeparator: ctx.sep,
    versionName: profile.id,
    nativesDir: ctx.nativesDir,
    gameDir,
    assetsDir: ctx.assetsDir,
    assetIndex: version.assets ?? version.assetIndex?.id ?? "legacy",
    classpath: classpath.join(ctx.sep),
  });
  return {
    loaderVersion: opts.loaderVersion,
    mainClass: merged.mainClass,
    classpath,
    downloadLibs: allLibs,
    natives,
    launchProfile: {
      jvmArgs: substituteArgs(flattenArguments(merged.jvm, ctx.os), vars),
      gameArgs: substituteArgs(flattenArguments(merged.game, ctx.os), vars),
    },
  };
}

/**
 * The real (best-effort, CI-gated) modular installer runner: download the loader
 * installer jar and run it in client mode against a cache install dir, then read the
 * launcher profile it writes (`versions/<id>/<id>.json`). This is the F4 analogue of
 * F3's CI-gated Fabric rendered launch — implemented for a GL/toolchain-capable
 * runner, NOT verified on the offline box; the multi-loader CI lane exercises it.
 * Forge uses `--installClient <dir>`; NeoForge uses `--install-client <dir>`.
 */
async function defaultRunInstaller(input: RunInstallerInput): Promise<LoaderProfileJson> {
  const installer = loaderInstallerArtifact(input.loader, input.mc, input.loaderVersion);
  const installRoot = join(input.cacheDir, "loaders", input.loader, input.loaderVersion);
  const installerJar = join(installRoot, "installer.jar");
  await download(input.fetchImpl, installer.url, installerJar);
  const { spawn } = await import("node:child_process");
  const flag = input.loader === "forge" ? "--installClient" : "--install-client";
  input.onLog(`java -jar ${installerJar} ${flag} ${installRoot}`);
  await new Promise<void>((resolveRun, reject) => {
    const child = spawn(input.javaPath, ["-jar", installerJar, flag, installRoot], { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolveRun()
        : reject(new Error(`INSTALLER_FAILED: ${input.loader} installer exited ${code ?? "?"}`)),
    );
  });
  // The installer writes one or more profiles under <installRoot>/versions/<id>/<id>.json;
  // pick the loader profile (the one that inheritsFrom the vanilla version).
  const versionsDir = join(installRoot, "versions");
  const ids = existsSync(versionsDir) ? readdirSync(versionsDir) : [];
  for (const id of ids) {
    const p = join(versionsDir, id, `${id}.json`);
    if (!existsSync(p)) continue;
    const profile = JSON.parse(readFileSync(p, "utf8")) as LoaderProfileJson;
    if (profile.inheritsFrom === input.mc || profile.id !== input.mc) return profile;
  }
  throw new Error(`INSTALLER_PROFILE_NOT_FOUND: no ${input.loader} launcher profile under ${versionsDir}`);
}

/** Newest stable Fabric loader version for `mc` (Fabric meta loader list). */
async function resolveFabricLoader(f: typeof fetch, mc: string): Promise<string> {
  const loaders = await fetchJson<FabricLoaderEntry[]>(f, `${FABRIC_META}/versions/loader/${mc}`);
  return pickFabricLoader(loaders);
}

/** Fabric's maven (hosts the production, intermediary-mapped Fabric API mod jar). */
const FABRIC_MAVEN = "https://maven.fabricmc.net";

/**
 * Resolve + download the **Fabric API** mod jar for `mc` and return its cached path. The client-fabric
 * agent AND the SUT mods declare `depends: fabric-api`, so a Fabric/Quilt client refuses to launch
 * (`HARD_DEP_NO_CANDIDATE … fabric-api`) without it staged into `mods/`. Versions look like
 * `0.103.0+1.21.1`; we pick the newest whose `+<mc>` suffix matches. Robust: returns `null` (with a
 * warning) if it cannot resolve, so the boot still attempts (and fails loudly at the loader) rather
 * than the provisioner throwing.
 */
async function resolveFabricApiJar(
  f: typeof fetch,
  mc: string,
  cacheDir: string,
  log: (l: string) => void,
): Promise<string | null> {
  let version: string | undefined;
  try {
    const res = await f(`${FABRIC_MAVEN}/net/fabricmc/fabric-api/fabric-api/maven-metadata.xml`, {
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const all = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]!);
    const matching = all.filter((v) => v.endsWith(`+${mc}`)); // metadata is ascending → newest last
    version = matching[matching.length - 1];
  } catch (err) {
    log(`Could not resolve fabric-api for ${mc}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!version) {
    log(`WARN: no fabric-api build found for ${mc}; mods depending on it will fail to load.`);
    return null;
  }
  const jar = join(cacheDir, "fabric-api", `fabric-api-${version}.jar`);
  log(`Resolving Fabric API ${version} for ${mc}…`);
  await download(f, `${FABRIC_MAVEN}/net/fabricmc/fabric-api/fabric-api/${version}/fabric-api-${version}.jar`, jar);
  return jar;
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
