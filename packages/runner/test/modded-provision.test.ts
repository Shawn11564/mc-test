/**
 * F5 — pure modded-server provisioning helpers (no boot, no network): the loader
 * family router, the Fabric server-launcher URL, the Forge/NeoForge installer maven
 * coordinates, the `@args` file discovery, and the boot-log mod-load parser. The
 * actual install+boot is acceptance-only (e2e harness); these gate the wiring in CI.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loaderFamily,
  fabricServerLauncherUrl,
  loaderInstallerMaven,
  findArgsFile,
} from "../src/provision/ModdedProvisioner.js";
import { parseLoadedMods, modLoadResult } from "../src/provision/serverCommon.js";
import { serverUsesBukkit } from "../src/provision/provisionServer.js";

describe("serverUsesBukkit (server-family routing)", () => {
  it("an explicit serverIsBukkit wins — a rendered-client row names a mod loader but boots a PAPER server", () => {
    // The fabric/forge/neoforge `-client` rows set `loader` to the CLIENT loader but boot a Paper server
    // (server.paper) for the rendered client to connect to. The CLI passes serverIsBukkit=true, so the
    // router MUST pick Paper, not the modded path (else it resolves a Fabric server with loaderVersion
    // undefined → HTTP 400). Regression guard for that bug.
    expect(serverUsesBukkit(true, "fabric")).toBe(true);
    expect(serverUsesBukkit(true, "forge")).toBe(true);
    expect(serverUsesBukkit(true, "neoforge")).toBe(true);
    expect(serverUsesBukkit(false, "paper")).toBe(false); // explicit false forces modded even for a bukkit loader
  });

  it("falls back to the loader family when serverIsBukkit is unset (the F5 modded-server rows)", () => {
    expect(serverUsesBukkit(undefined, "paper")).toBe(true);
    expect(serverUsesBukkit(undefined, "spigot")).toBe(true);
    expect(serverUsesBukkit(undefined, "fabric")).toBe(false);
    expect(serverUsesBukkit(undefined, "forge")).toBe(false);
    expect(serverUsesBukkit(undefined, "neoforge")).toBe(false);
  });
});

describe("loaderFamily", () => {
  it("maps paper/spigot/folia → bukkit, mod loaders to themselves, else vanilla", () => {
    expect(loaderFamily("paper")).toBe("bukkit");
    expect(loaderFamily("spigot")).toBe("bukkit");
    expect(loaderFamily("folia")).toBe("bukkit");
    expect(loaderFamily("fabric")).toBe("fabric");
    expect(loaderFamily("quilt")).toBe("quilt");
    expect(loaderFamily("forge")).toBe("forge");
    expect(loaderFamily("neoforge")).toBe("neoforge");
    expect(loaderFamily("vanilla")).toBe("vanilla");
  });
});

describe("server source URLs/coordinates (the verified-live shapes)", () => {
  it("fabricServerLauncherUrl builds the meta server/jar endpoint", () => {
    expect(fabricServerLauncherUrl("1.21.1", "0.19.3", "1.0.1")).toBe(
      "https://meta.fabricmc.net/v2/versions/loader/1.21.1/0.19.3/1.0.1/server/jar",
    );
  });

  it("loaderInstallerMaven: forge uses <mc>-<ver>, neoforge uses <ver>", () => {
    const forge = loaderInstallerMaven("forge", "1.20.1", "47.3.39");
    expect(forge.filename).toBe("forge-1.20.1-47.3.39-installer.jar");
    expect(forge.url).toBe(
      "https://maven.minecraftforge.net/net/minecraftforge/forge/1.20.1-47.3.39/forge-1.20.1-47.3.39-installer.jar",
    );
    const neo = loaderInstallerMaven("neoforge", "1.21.1", "21.1.66");
    expect(neo.filename).toBe("neoforge-21.1.66-installer.jar");
    expect(neo.url).toBe(
      "https://maven.neoforged.net/releases/net/neoforged/neoforge/21.1.66/neoforge-21.1.66-installer.jar",
    );
  });
});

describe("findArgsFile (Forge/NeoForge @args discovery)", () => {
  it("finds <os>_args.txt under libraries/ and returns an @relative path", () => {
    const dir = mkdtempSync(join(tmpdir(), "mctest-args-"));
    const argsDir = join(dir, "libraries", "net", "neoforged", "neoforge", "21.1.66");
    mkdirSync(argsDir, { recursive: true });
    writeFileSync(join(argsDir, "unix_args.txt"), "-cp ...\nnet.neoforged.Main\n");
    writeFileSync(join(argsDir, "win_args.txt"), "-cp ...\r\nnet.neoforged.Main\r\n");

    expect(findArgsFile(dir, "linux")).toBe("@libraries/net/neoforged/neoforge/21.1.66/unix_args.txt");
    expect(findArgsFile(dir, "win32")).toBe("@libraries/net/neoforged/neoforge/21.1.66/win_args.txt");
    rmSync(dir, { recursive: true, force: true });
  });

  it("throws UNSUPPORTED_TARGET when the installer produced no args file", () => {
    const dir = mkdtempSync(join(tmpdir(), "mctest-args-"));
    mkdirSync(join(dir, "libraries"), { recursive: true });
    expect(() => findArgsFile(dir, "linux")).toThrow(/UNSUPPORTED_TARGET/);
    rmSync(dir, { recursive: true, force: true });
  });
});

const FABRIC_LOG = [
  "[12:00:00] [main/INFO] (FabricLoader/Game) Loading 5 mods:",
  "\t- fabricloader 0.16.3",
  "\t- ferritecore 7.0.3",
  "\t- java 21",
  "\t- minecraft 1.21.1",
  "\t-- mixinextras 0.4.1",
  "[12:00:05] [Server thread/INFO]: Done (8.123s)! For help, type \"help\"",
].join("\n");

const FORGE_LOG = [
  "[12:00:00] [main/INFO] [ModFileParser]: Found mod file ferritecore-6.0.1-forge.jar",
  "[12:00:02] [main/INFO] [LOADING]: Loading mod ferritecore",
  '[12:00:08] [Server thread/INFO]: Done (10.5s)! For help, type "help"',
].join("\n");

describe("parseLoadedMods (Fabric mod-list block)", () => {
  it("extracts mod ids from the `- <id> <ver>` entries (incl. sub-mods)", () => {
    const ids = parseLoadedMods(FABRIC_LOG, "fabric");
    expect(ids).toContain("ferritecore");
    expect(ids).toContain("fabricloader");
    expect(ids).toContain("mixinextras");
  });

  it("returns [] for forge/neoforge (their FML list is parsed by presence check)", () => {
    expect(parseLoadedMods(FORGE_LOG, "forge")).toEqual([]);
  });
});

describe("modLoadResult (boot-log mod-load detection)", () => {
  it("fabric: expected id present in the mod-list → seen, absent → missing", () => {
    const ok = modLoadResult(FABRIC_LOG, "fabric", ["ferritecore"]);
    expect(ok.seen).toEqual(["ferritecore"]);
    expect(ok.missing).toEqual([]);

    const bad = modLoadResult(FABRIC_LOG, "fabric", ["does-not-exist"]);
    expect(bad.seen).toEqual([]);
    expect(bad.missing).toEqual(["does-not-exist"]);
  });

  it("forge: expected id detected by word-boundary in the FML log", () => {
    const r = modLoadResult(FORGE_LOG, "forge", ["ferritecore"]);
    expect(r.seen).toEqual(["ferritecore"]);
    expect(r.missing).toEqual([]);
  });

  it("forge/neoforge: boot-log is POSITIVE-ONLY — an absent id is inconclusive, never `missing`", () => {
    // Forge 1.20.1 logs mod discovery only to debug.log (NOT the captured stdout), so a token
    // that doesn't appear is NOT proof the mod failed to load. `missing` must stay empty for FML
    // loaders so the `expectMods` gate never falsely fires MOD_NOT_LOADED and preempts the
    // authoritative MCTP `mod.loaded` assertion. (Fabric/Quilt keep the hard signal — see above.)
    const quietForge = '[12:00:08] [Server thread/INFO]: Done (10.5s)! For help, type "help"';
    const forge = modLoadResult(quietForge, "forge", ["ferritecore"]);
    expect(forge.seen).toEqual([]);
    expect(forge.missing).toEqual([]); // inconclusive, NOT ["ferritecore"]

    const neo = modLoadResult(quietForge, "neoforge", ["ferritecore"]);
    expect(neo.missing).toEqual([]);

    // Fabric still hard-fails an absent expected mod (its console list is complete/reliable).
    expect(modLoadResult(quietForge, "fabric", ["ferritecore"]).missing).toEqual(["ferritecore"]);
  });
});
