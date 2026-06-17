/**
 * F4 multi-loader launch core (pure). The Forge/NeoForge rendered launch needs
 * the loader installer to run on a GL-capable host (CI-gated), but the launch
 * ASSEMBLY around it — installer-coordinate resolution, `${…}` substitution,
 * OS-rule argument flattening, and merging the loader profile onto vanilla — is
 * pure and unit-testable with no JVM, no network, no client. These are the pieces
 * `ClientProvisioner` composes for the modular path.
 */
import { describe, it, expect } from "vitest";
import {
  loaderInstallerArtifact,
  substituteArgs,
  flattenArguments,
  mergeLaunchProfile,
  isModularLoader,
  isFabricLike,
  type ArgEntry,
  type LoaderProfileJson,
} from "../src/launch/loaders.js";
import type { VersionJson } from "../src/launch/resolve.js";

describe("loader classification", () => {
  it("splits fabric-like from modular loaders", () => {
    expect(isFabricLike("fabric")).toBe(true);
    expect(isFabricLike("quilt")).toBe(true);
    expect(isFabricLike("forge")).toBe(false);
    expect(isModularLoader("forge")).toBe(true);
    expect(isModularLoader("neoforge")).toBe(true);
    expect(isModularLoader("fabric")).toBe(false);
  });
});

describe("loaderInstallerArtifact — maven coordinate → installer jar", () => {
  it("resolves the Forge installer (version is <mc>-<forge>) on the Forge maven", () => {
    const a = loaderInstallerArtifact("forge", "1.20.1", "47.2.0");
    expect(a.url).toBe(
      "https://maven.minecraftforge.net/net/minecraftforge/forge/1.20.1-47.2.0/forge-1.20.1-47.2.0-installer.jar",
    );
    expect(a.path).toBe("net/minecraftforge/forge/1.20.1-47.2.0/forge-1.20.1-47.2.0-installer.jar");
  });

  it("resolves the NeoForge installer (standalone version) on the NeoForged maven", () => {
    const a = loaderInstallerArtifact("neoforge", "1.21.1", "21.1.66");
    expect(a.url).toBe(
      "https://maven.neoforged.net/releases/net/neoforged/neoforge/21.1.66/neoforge-21.1.66-installer.jar",
    );
  });
});

describe("substituteArgs — ${placeholder} expansion", () => {
  it("substitutes known vars and leaves unknown placeholders intact", () => {
    const out = substituteArgs(
      ["-DlibraryDirectory=${library_directory}", "${classpath}", "--user", "${auth_player_name}"],
      { library_directory: "/libs", classpath: "/a.jar:/b.jar" },
    );
    expect(out).toEqual(["-DlibraryDirectory=/libs", "/a.jar:/b.jar", "--user", "${auth_player_name}"]);
  });

  it("handles multiple placeholders in one token", () => {
    expect(substituteArgs(["${a}/${b}"], { a: "x", b: "y" })).toEqual(["x/y"]);
  });
});

describe("flattenArguments — OS rules + feature gating", () => {
  const linux = "linux" as const;
  it("keeps literals, applies OS rules, and drops feature-gated args", () => {
    const args: ArgEntry[] = [
      "--always",
      { rules: [{ action: "allow", os: { name: "linux" } }], value: "--on-linux" },
      { rules: [{ action: "allow", os: { name: "windows" } }], value: "--on-windows" },
      { rules: [{ action: "allow", features: { is_demo_user: true } }], value: "--demo" },
      { rules: [{ action: "allow", os: { name: "linux" } }], value: ["--pair", "v"] },
    ];
    expect(flattenArguments(args, linux)).toEqual(["--always", "--on-linux", "--pair", "v"]);
  });

  it("returns [] for undefined", () => {
    expect(flattenArguments(undefined, linux)).toEqual([]);
  });
});

describe("mergeLaunchProfile — loader profile onto vanilla", () => {
  const vanilla: VersionJson = {
    id: "1.21.1",
    mainClass: "net.minecraft.client.main.Main",
    libraries: [{ name: "com.vanilla:lib:1.0", downloads: { artifact: { path: "v.jar", url: "https://x/v.jar" } } }],
    // modern vanilla version JSONs carry arguments
    ...({ arguments: { jvm: ["-DvanillaJvm"], game: ["--username", "${auth_player_name}"] } } as object),
  } as VersionJson;

  it("prepends loader libraries, concatenates args, and takes the loader main class", () => {
    const loader: LoaderProfileJson = {
      id: "1.21.1-forge-52.0.0",
      inheritsFrom: "1.21.1",
      mainClass: "cpw.mods.bootstraplauncher.BootstrapLauncher",
      libraries: [{ name: "net.minecraftforge:forge:1.21.1-52.0.0", downloads: { artifact: { path: "f.jar", url: "https://x/f.jar" } } }],
      arguments: { jvm: ["-DforgeJvm"], game: ["--launchTarget", "forgeclient"] },
    };
    const merged = mergeLaunchProfile(vanilla, loader);
    expect(merged.mainClass).toBe("cpw.mods.bootstraplauncher.BootstrapLauncher");
    // loader lib FIRST (it wins), then vanilla.
    expect(merged.libraries.map((l) => l.name)).toEqual([
      "net.minecraftforge:forge:1.21.1-52.0.0",
      "com.vanilla:lib:1.0",
    ]);
    // args concatenated vanilla-then-loader.
    expect(merged.jvm).toEqual(["-DvanillaJvm", "-DforgeJvm"]);
    expect(merged.game).toEqual(["--username", "${auth_player_name}", "--launchTarget", "forgeclient"]);
  });

  it("supports a legacy profile using minecraftArguments", () => {
    const legacy: LoaderProfileJson = {
      id: "old",
      mainClass: "cpw.mods.fml.Main",
      libraries: [],
      minecraftArguments: "--tweakClass forge.Tweaker --extra",
    };
    const merged = mergeLaunchProfile(vanilla, legacy);
    expect(merged.game).toEqual(["--username", "${auth_player_name}", "--tweakClass", "forge.Tweaker", "--extra"]);
  });
});
