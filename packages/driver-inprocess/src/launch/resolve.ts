/**
 * Pure resolution of a launchable Minecraft + Fabric client from Mojang's
 * version manifest and Fabric's loader-profile meta. No I/O happens here — every
 * function takes already-parsed JSON and returns the artifacts/classpath/args the
 * provisioner downloads and the launcher runs. That keeps the hard parts (library
 * OS-rule filtering, natives selection, maven-coord → url, asset object layout)
 * unit-testable without the network or a JVM (ROADMAP §8.2/§8.3).
 *
 * Shapes are partial views of the real JSON — only the fields we read are typed.
 */

/** Target OS name as it appears in Mojang library rules. */
export type MojangOs = "windows" | "osx" | "linux";

/** Map a Node platform to the Mojang OS name used in library `rules`/natives. */
export function mojangOs(platform: NodeJS.Platform): MojangOs {
  if (platform === "win32") return "windows";
  if (platform === "darwin") return "osx";
  return "linux";
}

/** A concrete file to fetch: its repo-relative `path`, absolute `url`, and (optional) `sha1`/`size`. */
export interface ResolvedArtifact {
  path: string;
  url: string;
  sha1?: string;
  size?: number;
}

// ---- Mojang version manifest + version JSON (partial) ----------------------

export interface VersionManifest {
  latest?: { release?: string; snapshot?: string };
  versions: { id: string; type: string; url: string; sha1?: string }[];
}

interface MojangRuleOs {
  name?: string;
  arch?: string;
  version?: string;
}
interface MojangRule {
  action: "allow" | "disallow";
  os?: MojangRuleOs;
  features?: Record<string, boolean>;
}
interface MojangDownload {
  path?: string;
  url: string;
  sha1?: string;
  size?: number;
}
interface MojangLibrary {
  name: string;
  downloads?: {
    artifact?: MojangDownload;
    classifiers?: Record<string, MojangDownload>;
  };
  /** Legacy (≤1.18) natives map: os name → classifier key in `downloads.classifiers`. */
  natives?: Record<string, string>;
  rules?: MojangRule[];
  url?: string;
}
export interface VersionJson {
  id: string;
  mainClass: string;
  assets?: string;
  assetIndex?: { id: string; url: string; sha1?: string; size?: number; totalSize?: number };
  downloads?: { client?: MojangDownload; server?: MojangDownload };
  libraries: MojangLibrary[];
  javaVersion?: { component?: string; majorVersion?: number };
}

/** Pick the version entry for `mc` from the manifest, or throw a clear error. */
export function pickVersion(manifest: VersionManifest, mc: string): { id: string; url: string; sha1?: string } {
  const v = manifest.versions.find((x) => x.id === mc);
  if (!v) {
    throw new Error(
      `MC_VERSION_NOT_FOUND: ${mc} is not in the Mojang version manifest (have ${manifest.versions.length} versions)`,
    );
  }
  return { id: v.id, url: v.url, ...(v.sha1 ? { sha1: v.sha1 } : {}) };
}

/**
 * Evaluate Mojang library `rules` for the current OS. Convention: start denied,
 * and each rule whose `os` matches (or is absent) sets the verdict to its action;
 * the last matching rule wins. Feature rules (demo / custom resolution) never
 * apply to libraries, so a feature-gated rule is treated as non-matching here.
 */
export function ruleAllows(rules: MojangRule[] | undefined, os: MojangOs): boolean {
  if (!rules || rules.length === 0) return true;
  let allowed = false;
  for (const rule of rules) {
    if (rule.features) continue; // feature-gated rules don't apply to libraries
    const matches = !rule.os || rule.os.name === undefined || rule.os.name === os;
    if (matches) allowed = rule.action === "allow";
  }
  return allowed;
}

/** Parse a maven coordinate `group:artifact:version[:classifier][@ext]`. */
export interface MavenCoord {
  group: string;
  artifact: string;
  version: string;
  classifier?: string;
  ext: string;
}
export function parseMaven(name: string): MavenCoord {
  const [coordsRaw, extRaw] = name.split("@");
  const ext = extRaw ?? "jar";
  const parts = (coordsRaw ?? "").split(":");
  const [group, artifact, version, classifier] = parts;
  if (!group || !artifact || !version) {
    throw new Error(`BAD_MAVEN_COORD: cannot parse "${name}"`);
  }
  return { group, artifact, version, ext, ...(classifier ? { classifier } : {}) };
}

/** Maven coord → repo-relative path (`group/with/slashes/artifact/version/artifact-version[-classifier].ext`). */
export function mavenPath(c: MavenCoord): string {
  const file = `${c.artifact}-${c.version}${c.classifier ? `-${c.classifier}` : ""}.${c.ext}`;
  return `${c.group.replace(/\./g, "/")}/${c.artifact}/${c.version}/${file}`;
}

/** Maven coord → absolute url against a repo base (base may or may not end in `/`). */
export function mavenUrl(baseUrl: string, c: MavenCoord): string {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return base + mavenPath(c);
}

/** True if a maven classifier denotes a natives jar for some OS (`natives-windows`, `natives-macos-arm64`, …). */
export function isNativesClassifier(classifier: string | undefined): boolean {
  return !!classifier && /^natives-/.test(classifier);
}

/** True if a `natives-…` classifier targets THIS os (and, if it pins an arch, this arch). */
export function nativesMatch(classifier: string, os: MojangOs, arch: string): boolean {
  // Mojang uses `macos` in classifiers but `osx` in rule os.name.
  const osTokens = os === "osx" ? ["macos", "osx"] : [os];
  const m = /^natives-([a-z]+)(?:-([a-z0-9_]+))?$/.exec(classifier);
  if (!m) return false;
  const cOs = m[1] ?? "";
  const cArch = m[2];
  if (!osTokens.includes(cOs)) return false;
  if (!cArch) return true;
  const a = arch === "arm64" ? ["arm64", "aarch64"] : arch === "x64" ? ["x64", "amd64", "x86_64"] : [arch];
  return a.includes(cArch);
}

/**
 * Split a version JSON's libraries into the classpath jars and the natives jars
 * (to be extracted into the natives dir), filtered for the target OS/arch. Handles
 * both the modern style (each native is its own `:natives-<os>` library entry with
 * a `downloads.artifact`) and the legacy style (a `natives` map + `classifiers`).
 */
export function selectLibraries(
  version: VersionJson,
  platform: NodeJS.Platform,
  arch: string,
): { classpath: ResolvedArtifact[]; natives: ResolvedArtifact[] } {
  const os = mojangOs(platform);
  const classpath: ResolvedArtifact[] = [];
  const natives: ResolvedArtifact[] = [];

  for (const lib of version.libraries) {
    if (!ruleAllows(lib.rules, os)) continue;
    const coord = safeParse(lib.name);

    // Modern: a single artifact whose classifier may mark it as natives.
    const art = lib.downloads?.artifact;
    if (art?.url && art.path) {
      const classifier = coord?.classifier;
      if (isNativesClassifier(classifier)) {
        if (nativesMatch(classifier as string, os, arch)) natives.push(toArtifact(art));
      } else {
        classpath.push(toArtifact(art));
      }
    }

    // Legacy: a `natives` map → a classifier key in `downloads.classifiers`.
    const nativeKey = lib.natives?.[os] ?? lib.natives?.[os === "osx" ? "macos" : os];
    if (nativeKey) {
      const key = nativeKey.replace("${arch}", arch === "arm64" ? "64" : "64");
      const cls = lib.downloads?.classifiers?.[key] ?? lib.downloads?.classifiers?.[nativeKey];
      if (cls?.url && cls.path) natives.push(toArtifact(cls));
    }

    // A bare maven lib with only a `url` (rare in vanilla, common in Fabric — handled there).
    if (!art && !nativeKey && lib.url && coord) {
      classpath.push({ path: mavenPath(coord), url: mavenUrl(lib.url, coord) });
    }
  }

  return { classpath, natives };
}

function safeParse(name: string): MavenCoord | undefined {
  try {
    return parseMaven(name);
  } catch {
    return undefined;
  }
}
function toArtifact(d: MojangDownload): ResolvedArtifact {
  return {
    path: d.path ?? "",
    url: d.url,
    ...(d.sha1 ? { sha1: d.sha1 } : {}),
    ...(d.size !== undefined ? { size: d.size } : {}),
  };
}

/** The vanilla client jar artifact, or throw. */
export function clientJar(version: VersionJson): MojangDownload {
  const c = version.downloads?.client;
  if (!c?.url) throw new Error(`NO_CLIENT_JAR: version ${version.id} has no downloads.client`);
  return c;
}

// ---- Fabric loader profile (partial) --------------------------------------

export interface FabricLoaderEntry {
  loader: { version: string; stable?: boolean };
}
export interface FabricProfile {
  id: string;
  inheritsFrom?: string;
  mainClass: string;
  libraries: { name: string; url?: string }[];
  arguments?: { jvm?: string[]; game?: string[] };
}

/** Pick the loader version to use: the newest STABLE entry from Fabric's per-mc loader list. */
export function pickFabricLoader(loaders: FabricLoaderEntry[]): string {
  const stable = loaders.find((l) => l.loader.stable) ?? loaders[0];
  if (!stable) throw new Error("NO_FABRIC_LOADER: Fabric meta returned no loader versions");
  return stable.loader.version;
}

/** Default maven repo for a Fabric library entry that omits its own `url`. */
const FABRIC_MAVEN = "https://maven.fabricmc.net/";

/** Resolve every Fabric profile library to a downloadable artifact (classpath jars). */
export function fabricLibraries(profile: FabricProfile): ResolvedArtifact[] {
  return profile.libraries.map((lib) => {
    const coord = parseMaven(lib.name);
    const base = lib.url && lib.url.length > 0 ? lib.url : FABRIC_MAVEN;
    return { path: mavenPath(coord), url: mavenUrl(base, coord) };
  });
}

// ---- Asset index (partial) ------------------------------------------------

export interface AssetIndexJson {
  objects: Record<string, { hash: string; size: number }>;
}
/** Resource server for hashed asset objects. */
export const RESOURCES_BASE = "https://resources.download.minecraft.net";

/** Flatten an asset index into the concrete object downloads (`objects/<ab>/<hash>`). */
export function assetDownloads(index: AssetIndexJson): ResolvedArtifact[] {
  const seen = new Set<string>();
  const out: ResolvedArtifact[] = [];
  for (const obj of Object.values(index.objects)) {
    if (seen.has(obj.hash)) continue;
    seen.add(obj.hash);
    const sub = obj.hash.slice(0, 2);
    out.push({
      path: `objects/${sub}/${obj.hash}`,
      url: `${RESOURCES_BASE}/${sub}/${obj.hash}`,
      sha1: obj.hash,
      size: obj.size,
    });
  }
  return out;
}
