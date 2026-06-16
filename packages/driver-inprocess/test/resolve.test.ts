/**
 * Pure resolution of the launchable client (the hard parts: OS-rule library
 * filtering, natives selection, maven-coord → url, asset object layout). No
 * network — every function takes parsed JSON.
 */
import { describe, it, expect } from "vitest";
import {
  pickVersion,
  ruleAllows,
  parseMaven,
  mavenPath,
  mavenUrl,
  selectLibraries,
  clientJar,
  fabricLibraries,
  pickFabricLoader,
  assetDownloads,
  type VersionJson,
  type FabricProfile,
} from "../src/launch/resolve.js";

describe("pickVersion", () => {
  const manifest = { versions: [{ id: "1.21.1", type: "release", url: "https://x/1.21.1.json" }] };
  it("finds the requested version", () => {
    expect(pickVersion(manifest, "1.21.1").url).toBe("https://x/1.21.1.json");
  });
  it("throws a clear error for an unknown version", () => {
    expect(() => pickVersion(manifest, "1.99")).toThrow(/MC_VERSION_NOT_FOUND/);
  });
});

describe("ruleAllows", () => {
  it("allows when there are no rules", () => {
    expect(ruleAllows(undefined, "linux")).toBe(true);
  });
  it("respects an allow + os-specific disallow (last match wins)", () => {
    const rules = [{ action: "allow" as const }, { action: "disallow" as const, os: { name: "osx" } }];
    expect(ruleAllows(rules, "osx")).toBe(false);
    expect(ruleAllows(rules, "linux")).toBe(true);
  });
  it("an os-only allow excludes other OSes", () => {
    const rules = [{ action: "allow" as const, os: { name: "windows" } }];
    expect(ruleAllows(rules, "windows")).toBe(true);
    expect(ruleAllows(rules, "linux")).toBe(false);
  });
});

describe("maven coords", () => {
  it("parses group:artifact:version[:classifier]", () => {
    expect(parseMaven("net.fabricmc:fabric-loader:0.16.5")).toMatchObject({
      group: "net.fabricmc",
      artifact: "fabric-loader",
      version: "0.16.5",
    });
    expect(parseMaven("org.lwjgl:lwjgl:3.3.3:natives-windows").classifier).toBe("natives-windows");
  });
  it("builds the repo path and url", () => {
    const c = parseMaven("net.fabricmc:fabric-loader:0.16.5");
    expect(mavenPath(c)).toBe("net/fabricmc/fabric-loader/0.16.5/fabric-loader-0.16.5.jar");
    expect(mavenUrl("https://maven.fabricmc.net/", c)).toBe(
      "https://maven.fabricmc.net/net/fabricmc/fabric-loader/0.16.5/fabric-loader-0.16.5.jar",
    );
  });
});

describe("selectLibraries", () => {
  const version: VersionJson = {
    id: "1.21.1",
    mainClass: "net.minecraft.client.main.Main",
    libraries: [
      { name: "com.example:lib:1.0", downloads: { artifact: { path: "com/example/lib/1.0/lib-1.0.jar", url: "https://libs/lib.jar" } } },
      {
        name: "org.lwjgl:lwjgl:3.3.3:natives-windows",
        downloads: { artifact: { path: "org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar", url: "https://libs/nat-win.jar" } },
        rules: [{ action: "allow", os: { name: "windows" } }],
      },
      {
        name: "org.lwjgl:lwjgl:3.3.3:natives-linux",
        downloads: { artifact: { path: "org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-linux.jar", url: "https://libs/nat-lin.jar" } },
        rules: [{ action: "allow", os: { name: "linux" } }],
      },
      {
        name: "ca.weblite:java-objc-bridge:1.1",
        downloads: { artifact: { path: "ca/weblite/maclib.jar", url: "https://libs/mac.jar" } },
        rules: [{ action: "allow", os: { name: "osx" } }],
      },
    ],
  };

  it("partitions classpath vs natives for linux/x64", () => {
    const { classpath, natives } = selectLibraries(version, "linux", "x64");
    expect(classpath.map((a) => a.url)).toEqual(["https://libs/lib.jar"]);
    expect(natives.map((a) => a.url)).toEqual(["https://libs/nat-lin.jar"]);
  });
  it("picks the windows natives on win32", () => {
    const { classpath, natives } = selectLibraries(version, "win32", "x64");
    expect(classpath.map((a) => a.url)).toEqual(["https://libs/lib.jar"]);
    expect(natives.map((a) => a.url)).toEqual(["https://libs/nat-win.jar"]);
  });
});

describe("clientJar", () => {
  it("returns the client download", () => {
    const v: VersionJson = { id: "x", mainClass: "M", libraries: [], downloads: { client: { url: "https://c/client.jar" } } };
    expect(clientJar(v).url).toBe("https://c/client.jar");
  });
  it("throws when there is no client jar", () => {
    expect(() => clientJar({ id: "x", mainClass: "M", libraries: [] })).toThrow(/NO_CLIENT_JAR/);
  });
});

describe("fabricLibraries", () => {
  it("resolves each library against its url (or the default fabric maven)", () => {
    const profile: FabricProfile = {
      id: "fabric-loader-0.16.5-1.21.1",
      mainClass: "net.fabricmc.loader.impl.launch.knot.KnotClient",
      libraries: [
        { name: "net.fabricmc:fabric-loader:0.16.5", url: "https://maven.fabricmc.net/" },
        { name: "org.ow2.asm:asm:9.7" }, // no url → default fabric maven
      ],
    };
    const libs = fabricLibraries(profile);
    expect(libs[0]?.url).toBe("https://maven.fabricmc.net/net/fabricmc/fabric-loader/0.16.5/fabric-loader-0.16.5.jar");
    expect(libs[1]?.url).toBe("https://maven.fabricmc.net/org/ow2/asm/asm/9.7/asm-9.7.jar");
  });
});

describe("pickFabricLoader", () => {
  it("prefers the newest stable loader", () => {
    const loaders = [
      { loader: { version: "0.17.0-beta", stable: false } },
      { loader: { version: "0.16.5", stable: true } },
    ];
    expect(pickFabricLoader(loaders)).toBe("0.16.5");
  });
});

describe("assetDownloads", () => {
  it("flattens objects to objects/<ab>/<hash> and dedups", () => {
    const index = {
      objects: {
        "icons/icon_16x16.png": { hash: "aabbccddeeff", size: 10 },
        "lang/en_us.json": { hash: "aabbccddeeff", size: 10 }, // dup hash
        "minecraft/sounds.json": { hash: "1234567890ab", size: 20 },
      },
    };
    const dl = assetDownloads(index);
    expect(dl).toHaveLength(2); // deduped by hash
    const icon = dl.find((d) => d.sha1 === "aabbccddeeff");
    expect(icon?.path).toBe("objects/aa/aabbccddeeff");
    expect(icon?.url).toBe("https://resources.download.minecraft.net/aa/aabbccddeeff");
  });
});
