import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { resolveSpigotJar, spigotJarPath, hasGit } from "../src/provision/buildtools.js";

describe("Spigot BuildTools resolver", () => {
  it("derives the cached jar path under <cacheDir>/spigot/", () => {
    expect(spigotJarPath("/cache", "1.8.9")).toBe(join("/cache", "spigot", "spigot-1.8.9.jar"));
  });

  it("returns the cached jar without building when it already exists (no git/network/build)", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "mctest-spigot-"));
    const jar = spigotJarPath(cacheDir, "1.8.9");
    mkdirSync(dirname(jar), { recursive: true });
    writeFileSync(jar, "fake-spigot");
    // javaPath is irrelevant on the cache-hit path; pass a bogus value to prove it isn't invoked.
    const got = await resolveSpigotJar("1.8.9", { cacheDir, javaPath: "/nonexistent/java" });
    expect(got).toBe(jar);
  });

  it("exposes git availability (a BuildTools prerequisite)", () => {
    expect(typeof hasGit()).toBe("boolean");
  });
});
