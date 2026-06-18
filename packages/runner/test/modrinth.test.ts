/**
 * F5 — the Modrinth source resolver. Proven offline by stubbing `fetch` with
 * canned Modrinth API + CDN responses (the same shapes the live API returns for
 * FerriteCore). Integrity is the PUBLISHED sha512; a mismatch fails loudly.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { resolveModrinth } from "../src/provision/modrinth.js";
import { resolveArtifact } from "../src/provision/sources.js";

const tmp = (): string => mkdtempSync(join(tmpdir(), "mctest-modrinth-"));
const JAR = "ferritecore-jar-bytes";
const sha512 = createHash("sha512").update(JAR).digest("hex");
const sha1 = createHash("sha1").update(JAR).digest("hex");

const FILE = {
  url: "https://cdn.modrinth.com/data/uXXizFIs/versions/sOzRw3CG/ferritecore-7.0.3-fabric.jar",
  filename: "ferritecore-7.0.3-fabric.jar",
  primary: true,
  hashes: { sha512, sha1 },
};
const VERSION = {
  id: "sOzRw3CG",
  version_number: "7.0.3-fabric",
  date_published: "2024-09-01T00:00:00Z",
  loaders: ["fabric"],
  game_versions: ["1.21.1"],
  files: [FILE],
};

const jsonResponse = (obj: unknown): Response =>
  new Response(JSON.stringify(obj), { status: 200, headers: { "content-type": "application/json" } });
const fileResponse = (body: string): Response => new Response(body, { status: 200 });
const notFound = (): Response => new Response("not found", { status: 404 });

/** A fetch stub routing the version-metadata GET and the CDN file GET. */
function stubFetch(routes: { version?: unknown; list?: unknown; file?: string; fileStatus?: number }) {
  const mock = vi.fn(async (url: string | URL): Promise<Response> => {
    const u = String(url);
    if (u.includes("/v2/version/")) return routes.version !== undefined ? jsonResponse(routes.version) : notFound();
    if (u.includes("/version?") || u.endsWith("/version"))
      return routes.list !== undefined ? jsonResponse(routes.list) : notFound();
    if (u === FILE.url) return new Response(routes.file ?? JAR, { status: routes.fileStatus ?? 200 });
    return notFound();
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

afterEach(() => vi.unstubAllGlobals());

describe("resolveModrinth — F5", () => {
  it("pinned version id: downloads, verifies the published sha512, caches (no re-download)", async () => {
    const dir = tmp();
    const fetchMock = stubFetch({ version: VERSION });
    const p = await resolveModrinth({ project: "ferrite-core", version: "sOzRw3CG" }, dir);
    expect(p).toContain("ferritecore-7.0.3-fabric.jar");
    expect(readFileSync(p, "utf8")).toBe(JAR);

    // Second resolve is a cache hit — the CDN file is fetched only once total.
    await resolveModrinth({ project: "ferrite-core", version: "sOzRw3CG" }, dir);
    const fileFetches = fetchMock.mock.calls.filter((c) => String(c[0]) === FILE.url).length;
    expect(fileFetches).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it("by project + loader + gameVersion: picks newest, logs the resolved id to pin", async () => {
    const dir = tmp();
    const logs: string[] = [];
    stubFetch({ list: [VERSION] });
    const p = await resolveModrinth(
      { project: "ferrite-core", loader: "fabric", gameVersion: "1.21.1" },
      dir,
      { log: (m) => logs.push(m) },
    );
    expect(readFileSync(p, "utf8")).toBe(JAR);
    expect(logs.join("\n")).toContain("sOzRw3CG"); // tells the author how to pin
    rmSync(dir, { recursive: true, force: true });
  });

  it("download not matching the published hash → ARTIFACT_CHECKSUM_MISMATCH", async () => {
    const dir = tmp();
    stubFetch({ version: VERSION, file: "TAMPERED" });
    await expect(resolveModrinth({ project: "ferrite-core", version: "sOzRw3CG" }, dir)).rejects.toThrow(
      /ARTIFACT_CHECKSUM_MISMATCH/,
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it("404 on the version → ARTIFACT_NOT_AVAILABLE (terminal, not retried forever)", async () => {
    const dir = tmp();
    stubFetch({});
    await expect(resolveModrinth({ project: "nope", version: "nope" }, dir, { retries: 0 })).rejects.toThrow(
      /ARTIFACT_NOT_AVAILABLE/,
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it("no version matches the filters → ARTIFACT_NOT_AVAILABLE", async () => {
    const dir = tmp();
    stubFetch({ list: [] });
    await expect(
      resolveModrinth({ project: "ferrite-core", loader: "forge", gameVersion: "1.99" }, dir, { retries: 0 }),
    ).rejects.toThrow(/ARTIFACT_NOT_AVAILABLE/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("resolveArtifact dispatches a `modrinth` source", async () => {
    const dir = tmp();
    stubFetch({ version: VERSION });
    const p = await resolveArtifact({ modrinth: { project: "ferrite-core", version: "sOzRw3CG" } }, dir);
    expect(readFileSync(p, "utf8")).toBe(JAR);
    rmSync(dir, { recursive: true, force: true });
  });
});
