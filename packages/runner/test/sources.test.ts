import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { resolveArtifact, sha256File } from "../src/provision/sources.js";

const tmp = (): string => mkdtempSync(join(tmpdir(), "mctest-src-"));
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

describe("resolveArtifact — F2 source integrity", () => {
  it("path source: returns the path; verifies sha256 when given", async () => {
    const dir = tmp();
    const f = join(dir, "plugin.jar");
    writeFileSync(f, "jarbytes");
    expect(await resolveArtifact({ path: f }, dir)).toBe(f);
    expect(await resolveArtifact({ path: f, sha256: sha("jarbytes") }, dir)).toBe(f);
    rmSync(dir, { recursive: true, force: true });
  });

  it("path source: throws on sha256 mismatch (swapped/corrupted artifact)", async () => {
    const dir = tmp();
    const f = join(dir, "plugin.jar");
    writeFileSync(f, "jarbytes");
    await expect(resolveArtifact({ path: f, sha256: sha("OTHER") }, dir)).rejects.toThrow(
      /ARTIFACT_CHECKSUM_MISMATCH/,
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it("path source: throws when the file is missing", async () => {
    const dir = tmp();
    await expect(resolveArtifact({ path: join(dir, "nope.jar") }, dir)).rejects.toThrow(/source not found/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("url source: refuses an unverified download (sha256 required)", async () => {
    const dir = tmp();
    await expect(resolveArtifact({ url: "https://example.com/x.jar" }, dir)).rejects.toThrow(/INTEGRITY_REQUIRED/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("unsupported source (no path/url) throws clearly", async () => {
    const dir = tmp();
    await expect(resolveArtifact({ sha256: "abc" }, dir)).rejects.toThrow(/unsupported plugin\/mod source/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("sha256File matches node crypto", async () => {
    const dir = tmp();
    const f = join(dir, "a.txt");
    writeFileSync(f, "hello");
    expect(await sha256File(f)).toBe(sha("hello"));
    rmSync(dir, { recursive: true, force: true });
  });
});
