/**
 * The rendered-client-on-MODDED-SERVER matrix shape (phase 2).
 *
 * Every earlier `driver: inprocess` row boots a PAPER server, which is right for a
 * client-side-only mod but leaves a SUT that is one mod loaded on BOTH sides (a shop
 * plugin's shape: the server half owns the state, the client half owns the GUI) with no
 * row to copy. These tests pin the two decisions that make that row work, with no boot:
 *
 *   1. server-family routing — a client row WITHOUT `server: { paper }` must provision a
 *      MODDED server, while one WITH it stays on Paper (the earlier regression);
 *   2. `clientMods` vs `mods` — the two sides get their own sets, and a `modrinth:` entry
 *      is legal on the client side (it has no local `path`, and silently dropping it would
 *      leave the client missing a dependency the SUT needs to load at all).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { serverUsesBukkit } from "../src/provision/provisionServer.js";
import { parseMatrix, findTarget, collectUnknownKeys } from "../src/index.js";

const repoMatrix = (name: string): string =>
  fileURLToPath(new URL(`../../../${name}`, import.meta.url));

describe("server-family routing for rendered-client rows", () => {
  it("a client row WITHOUT server:{paper} provisions a MODDED server", () => {
    // No explicit `serverIsBukkit` → the loader decides, and fabric is not bukkit-family.
    expect(serverUsesBukkit(undefined, "fabric")).toBe(false);
    expect(serverUsesBukkit(undefined, "neoforge")).toBe(false);
  });

  it("a client row WITH server:{paper} still boots Paper (the earlier regression)", () => {
    // The CLI resolves `serverIsBukkit: true` whenever `server.paper` is set, even though the
    // row's `loader` names the CLIENT loader. That must win over the loader family.
    expect(serverUsesBukkit(true, "fabric")).toBe(true);
    expect(serverUsesBukkit(true, "neoforge")).toBe(true);
  });

  it("a plain bukkit row is unaffected", () => {
    expect(serverUsesBukkit(undefined, "paper")).toBe(true);
    expect(serverUsesBukkit(undefined, "spigot")).toBe(true);
  });
});

describe("the canonical rendered-on-modded row in mc-test.yml", () => {
  const doc = parse(readFileSync(repoMatrix("mc-test.yml"), "utf8"));
  const matrix = parseMatrix(doc, "mc-test.yml");

  it("parses with no unknown-key warnings (clientMods is a KNOWN key, not a typo)", () => {
    expect(collectUnknownKeys(doc)).toEqual([]);
  });

  it("exists, drives a rendered client against a modded server, and pairs both agents", () => {
    const row = findTarget(matrix, "fabric-server-1.21-client");
    expect(row, "mc-test.yml must carry a rendered-client-on-modded-server row").toBeDefined();
    expect(row!.driver).toBe("inprocess"); // rendered client
    expect(row!.server).toBeUndefined(); // …and NO paper server → the modded path
    expect(serverUsesBukkit(!!row!.server?.paper || undefined, row!.loader!)).toBe(false);
    // Both halves are agent-backed: the client agent types/clicks, the server-mod agent
    // answers truth. server-bukkit would be wrong here — this is a Fabric server.
    expect(row!.agents).toContain("client-fabric");
    expect(row!.agents).toContain("server-fabric");
    expect(row!.agents).not.toContain("server-bukkit");
  });

  it("states the client's mod set separately from the server's", () => {
    const row = findTarget(matrix, "fabric-server-1.21-client")!;
    expect(row.clientMods?.length, "the client needs its own mod set").toBeGreaterThan(0);
    expect(row.mods?.length, "the server needs its own mod set").toBeGreaterThan(0);
    // A modrinth dep on the CLIENT side is the case that used to be dropped for having no path.
    expect(row.clientMods!.some((m) => m.modrinth !== undefined)).toBe(true);
  });
});
