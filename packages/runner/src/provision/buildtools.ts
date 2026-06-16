/**
 * Old-server jar source via Spigot BuildTools (v2 — completes the legacy real-boot).
 *
 * The PaperMC fill API cannot serve legacy versions (e.g. 1.8.x), and Spigot/CraftBukkit jars may
 * not be redistributed — so the only clean, automatable way to obtain a plugin-capable old server
 * is to BUILD it from source with Spigot's BuildTools. This downloads `BuildTools.jar` and runs it
 * under the version's JDK (1.8.x → Java 8, supplied by the multi-JDK resolver in `jdk.ts`),
 * producing a cached `spigot-<version>.jar`. Requires `git` on PATH (BuildTools shells out to it)
 * and network access; the build can take several minutes (cached thereafter).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, createWriteStream } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const BUILDTOOLS_URL =
  "https://hub.spigotmc.org/jenkins/job/BuildTools/lastSuccessfulBuild/artifact/target/BuildTools.jar";

export interface SpigotResolveOptions {
  cacheDir: string;
  /** The `java` executable used to RUN BuildTools — must match the version (e.g. Java 8 for 1.8.x). */
  javaPath: string;
  onLog?: (line: string) => void;
  /** Override the BuildTools.jar URL (for tests). */
  buildToolsUrl?: string;
}

/** The cached, built Spigot jar path for a version (`<cacheDir>/spigot/spigot-<version>.jar`). */
export function spigotJarPath(cacheDir: string, version: string): string {
  return join(cacheDir, "spigot", `spigot-${version}.jar`);
}

/** Whether `git` (a BuildTools prerequisite) is on PATH. */
export function hasGit(): boolean {
  try {
    return spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

/**
 * Resolve a plugin-capable Spigot server jar for `version`, building it with BuildTools (cached on
 * disk). Returns the path to `spigot-<version>.jar`. Throws `GIT_REQUIRED` when git is missing and
 * `BUILDTOOLS_*` on download/build failure (never a silent fallback to a plugin-incapable jar).
 */
export async function resolveSpigotJar(version: string, opts: SpigotResolveOptions): Promise<string> {
  const onLog = opts.onLog ?? (() => {});
  const outDir = join(opts.cacheDir, "spigot");
  const finalJar = spigotJarPath(opts.cacheDir, version);
  if (existsSync(finalJar)) {
    onLog(`Spigot ${version} (cached): ${finalJar}`);
    return finalJar;
  }
  // Fail fast on an invalid rev BEFORE the expensive build: a Spigot BuildTools rev can differ from
  // the MC version (e.g. MC 1.8.9 → Spigot rev 1.8.8). Verify it exists in the version manifest.
  const verRes = await fetch(`https://hub.spigotmc.org/versions/${version}.json`);
  if (!verRes.ok) {
    throw new Error(
      `SPIGOT_VERSION_NOT_FOUND: '${version}' is not a Spigot BuildTools rev (HTTP ${verRes.status} ` +
        `for versions/${version}.json). Spigot revs can differ from MC versions (e.g. 1.8.9 → 1.8.8); ` +
        `see https://hub.spigotmc.org/versions/.`,
    );
  }
  if (!hasGit()) {
    throw new Error(`GIT_REQUIRED: Spigot BuildTools needs 'git' on PATH to build ${version}`);
  }
  mkdirSync(outDir, { recursive: true });

  const btJar = join(outDir, "BuildTools.jar");
  if (!existsSync(btJar)) {
    onLog("Downloading Spigot BuildTools…");
    const res = await fetch(opts.buildToolsUrl ?? BUILDTOOLS_URL, { redirect: "follow" });
    if (!res.ok || !res.body) throw new Error(`BUILDTOOLS_DOWNLOAD_FAILED: HTTP ${res.status} for BuildTools.jar`);
    await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(btJar));
  }

  // Run BuildTools in a contained work dir, under the version's JDK; it emits spigot-<version>.jar
  // into --output-dir. Network + git + minutes of CPU; this is acceptance-grade work, cached after.
  const workDir = join(outDir, `build-${version}`);
  mkdirSync(workDir, { recursive: true });
  onLog(`Building Spigot ${version} with BuildTools under ${opts.javaPath} (can take several minutes)…`);
  const r = spawnSync(opts.javaPath, ["-jar", btJar, "--rev", version, "--output-dir", outDir], {
    cwd: workDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 128 * 1024 * 1024,
  });
  if (r.status !== 0) {
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    const tail = out.split(/\r?\n/).filter(Boolean).slice(-12).join("\n");
    throw new Error(`BUILDTOOLS_FAILED: Spigot ${version} build exited ${r.status}. Tail:\n${tail}`);
  }
  if (!existsSync(finalJar)) {
    throw new Error(`BUILDTOOLS_FAILED: no spigot-${version}.jar in ${outDir} after a successful BuildTools run`);
  }
  onLog(`Spigot ${version} built: ${finalJar}`);
  return finalJar;
}
