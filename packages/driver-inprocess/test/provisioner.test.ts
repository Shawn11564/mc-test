/**
 * The client provisioner end-to-end with an INJECTED fetch + a temp cache (no
 * network, no JVM): resolves the Mojang manifest/version JSON + Fabric profile,
 * "downloads" the client jar/libraries/natives, extracts the natives, stages the
 * SUT mod + client agent jar into a fresh `mods/`, and returns a ResolvedClient.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { provisionClient } from "../src/launch/ClientProvisioner.js";
import { makeStoredZip } from "./_zip.js";

const MANIFEST = "https://launchermeta.mojang.com/mc/game/version_manifest_v2.json";
const VERSION_URL = "https://piston-meta.example/1.21.1.json";
const ASSET_INDEX_URL = "https://piston-meta.example/17.json";
const CLIENT_JAR_URL = "https://piston-data.example/client.jar";
const VANILLA_LIB_URL = "https://libraries.minecraft.net/com/example/lib/1.0/lib-1.0.jar";
const NATIVES_URL = "https://libraries.minecraft.net/org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-linux.jar";
const LOADER_LIST = "https://meta.fabricmc.net/v2/versions/loader/1.21.1";
const PROFILE_URL = "https://meta.fabricmc.net/v2/versions/loader/1.21.1/0.16.5/profile/json";

const manifest = { versions: [{ id: "1.21.1", type: "release", url: VERSION_URL }] };
const versionJson = {
  id: "1.21.1",
  mainClass: "net.minecraft.client.main.Main",
  assets: "17",
  assetIndex: { id: "17", url: ASSET_INDEX_URL },
  downloads: { client: { url: CLIENT_JAR_URL } },
  libraries: [
    { name: "com.example:lib:1.0", downloads: { artifact: { path: "com/example/lib/1.0/lib-1.0.jar", url: VANILLA_LIB_URL } } },
    {
      name: "org.lwjgl:lwjgl:3.3.3:natives-linux",
      downloads: { artifact: { path: "org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-linux.jar", url: NATIVES_URL } },
      rules: [{ action: "allow", os: { name: "linux" } }],
    },
  ],
};
const loaderList = [{ loader: { version: "0.16.5", stable: true } }];
const profile = {
  id: "fabric-loader-0.16.5-1.21.1",
  mainClass: "net.fabricmc.loader.impl.launch.knot.KnotClient",
  libraries: [{ name: "net.fabricmc:fabric-loader:0.16.5", url: "https://maven.fabricmc.net/" }],
};
const nativesJar = makeStoredZip([{ name: "liblwjgl.so", data: Buffer.from("ELF-NATIVE") }]);

function makeFetch(): typeof fetch {
  return (async (url: string | URL): Promise<Response> => {
    const u = String(url);
    if (u === MANIFEST) return new Response(JSON.stringify(manifest));
    if (u === VERSION_URL) return new Response(JSON.stringify(versionJson));
    if (u === LOADER_LIST) return new Response(JSON.stringify(loaderList));
    if (u === PROFILE_URL) return new Response(JSON.stringify(profile));
    if (u === ASSET_INDEX_URL) return new Response(JSON.stringify({ objects: {} }));
    if (u === NATIVES_URL) return new Response(nativesJar);
    // Fabric API metadata (the agent + SUT mods hard-depend on fabric-api → staged into mods/).
    if (u.includes("fabric-api/maven-metadata.xml"))
      return new Response("<metadata><versioning><versions><version>0.103.0+1.21.1</version></versioning></metadata>");
    if (u.endsWith(".jar")) return new Response(Buffer.from(`fake:${u}`));
    throw new Error(`unexpected fetch: ${u}`);
  }) as typeof fetch;
}

describe("provisionClient (injected fetch)", () => {
  it("resolves, downloads, extracts natives, stages mods, and returns a ResolvedClient", async () => {
    const root = mkdtempSync(join(tmpdir(), "mctp-prov-"));
    const cacheDir = join(root, "cache");
    const workDir = join(root, "work");
    const modsSrc = join(root, "src");
    mkdirSync(modsSrc, { recursive: true });
    const sutMod = join(modsSrc, "openregions.jar");
    const agentJar = join(modsSrc, "agent-client-fabric.jar");
    writeFileSync(sutMod, "SUT");
    writeFileSync(agentJar, "AGENT");

    const client = await provisionClient({
      mc: "1.21.1",
      loader: "fabric",
      mods: [sutMod],
      clientAgentJar: agentJar,
      cacheDir,
      workDir,
      javaPath: "java",
      platform: "linux",
      arch: "x64",
      downloadAssets: false, // resolution + index only (skip the heavy object bundle)
      fetchImpl: makeFetch(),
    });

    // Resolved shape.
    expect(client.mc).toBe("1.21.1");
    expect(client.loader).toBe("fabric");
    expect(client.loaderVersion).toBe("0.16.5");
    expect(client.mainClass).toBe("net.fabricmc.loader.impl.launch.knot.KnotClient");
    expect(client.assetIndex).toBe("17");

    // Classpath = fabric lib + vanilla lib + client jar (natives are NOT on it).
    expect(client.classpath).toHaveLength(3);
    expect(client.classpath.some((p) => p.endsWith("client.jar"))).toBe(true);
    expect(client.classpath.some((p) => p.includes("fabric-loader"))).toBe(true);
    expect(client.classpath.some((p) => p.includes("lwjgl") && p.includes("natives"))).toBe(false);

    // Client jar + libraries were downloaded into the cache.
    expect(existsSync(join(cacheDir, "versions", "1.21.1", "client.jar"))).toBe(true);
    expect(existsSync(join(cacheDir, "libraries", "com/example/lib/1.0/lib-1.0.jar"))).toBe(true);

    // Natives were extracted (the .so pulled out of the natives jar).
    expect(existsSync(join(client.nativesDir, "liblwjgl.so"))).toBe(true);
    expect(readFileSync(join(client.nativesDir, "liblwjgl.so")).toString()).toBe("ELF-NATIVE");

    // Asset index file was fetched even with object download disabled.
    expect(existsSync(join(cacheDir, "assets", "indexes", "17.json"))).toBe(true);

    // The instance mods/ holds the SUT mod + the client agent jar + the resolved Fabric API jar.
    const staged = readdirSync(join(client.gameDir, "mods")).sort();
    expect(staged).toEqual(["agent-client-fabric.jar", "fabric-api-0.103.0+1.21.1.jar", "openregions.jar"]);
  });

  it("HONEST-SKIPs a modular loader (forge) that is not opted in — never a crash or false green", async () => {
    // F4: forge/neoforge rendered launch is CI-gated. Without the opt-in the
    // provisioner throws an UNSUPPORTED_TARGET the runner maps to an honest SKIP
    // (not the old hard UNSUPPORTED_LOADER crash that surfaced as a RED).
    await expect(
      provisionClient({ mc: "1.21.1", loader: "forge", fetchImpl: makeFetch() }),
    ).rejects.toThrow(/UNSUPPORTED_TARGET.*forge.*CI-gated/s);
    // The honest skip names the opt-in env var and the resolved installer url.
    await expect(
      provisionClient({ mc: "1.21.1", loader: "neoforge", fetchImpl: makeFetch() }),
    ).rejects.toThrow(/MC_TEST_RENDERED_LOADERS=neoforge/);
  });

  it("an unknown loader honest-skips (UNSUPPORTED_TARGET), never crashes", async () => {
    await expect(
      provisionClient({ mc: "1.21.1", loader: "vanilla", fetchImpl: makeFetch() }),
    ).rejects.toThrow(/UNSUPPORTED_TARGET.*fabric\/quilt\/forge\/neoforge/s);
  });

  it("opted-in modular loader (forge): runs the installer seam, merges its profile, assembles the launch", async () => {
    const root = mkdtempSync(join(tmpdir(), "mctp-forge-"));
    // A fixture launcher profile, as the (CI-gated) installer would produce. The
    // installer run is INJECTED — no JVM, no network — so the pure assembly
    // (merge + flatten + substitute) is exercised offline.
    const forgeProfile = {
      id: "1.21.1-forge-52.0.0",
      inheritsFrom: "1.21.1",
      mainClass: "cpw.mods.bootstraplauncher.BootstrapLauncher",
      libraries: [
        {
          name: "net.minecraftforge:forge:1.21.1-52.0.0",
          downloads: {
            artifact: {
              path: "net/minecraftforge/forge/1.21.1-52.0.0/forge-1.21.1-52.0.0.jar",
              url: "https://maven.minecraftforge.net/net/minecraftforge/forge/1.21.1-52.0.0/forge-1.21.1-52.0.0.jar",
            },
          },
        },
      ],
      arguments: {
        jvm: ["-DlibraryDirectory=${library_directory}", "-p", "${classpath}"],
        game: ["--username", "${auth_player_name}", "--launchTarget", "forgeclient", "--gameDir", "${game_directory}"],
      },
    };

    const client = await provisionClient({
      mc: "1.21.1",
      loader: "forge",
      loaderVersion: "52.0.0",
      experimentalLoaders: ["forge"], // opt in (no env needed)
      runInstaller: async () => forgeProfile, // CI-gated seam, injected
      cacheDir: join(root, "cache"),
      workDir: join(root, "work"),
      platform: "linux",
      arch: "x64",
      downloadAssets: false,
      fetchImpl: makeFetch(),
    });

    expect(client.loader).toBe("forge");
    expect(client.mainClass).toBe("cpw.mods.bootstraplauncher.BootstrapLauncher");
    // Modular launch profile assembled.
    expect(client.launchProfile).toBeDefined();
    // Path/version placeholders substituted at provision time…
    expect(client.launchProfile!.jvmArgs).toContain(`-DlibraryDirectory=${join(root, "cache", "libraries")}`);
    // …identity placeholders left for the launcher (substituted in buildClientLaunch).
    expect(client.launchProfile!.gameArgs).toContain("${auth_player_name}");
    expect(client.launchProfile!.gameArgs).toContain("forgeclient");
    // Classpath = forge lib + vanilla libs + client jar.
    expect(client.classpath.some((p) => p.includes("forge-1.21.1-52.0.0.jar"))).toBe(true);
    expect(client.classpath.some((p) => p.endsWith("client.jar"))).toBe(true);
  });

  it("fails clearly if a mod jar to stage is missing", async () => {
    const root = mkdtempSync(join(tmpdir(), "mctp-prov-"));
    await expect(
      provisionClient({
        mc: "1.21.1",
        loader: "fabric",
        mods: [join(root, "does-not-exist.jar")],
        cacheDir: join(root, "cache"),
        workDir: join(root, "work"),
        platform: "linux",
        arch: "x64",
        downloadAssets: false,
        fetchImpl: makeFetch(),
      }),
    ).rejects.toThrow(/MOD_JAR_MISSING/);
  });
});
