/**
 * The dependency-free natives extractor: pulls only `.dll`/`.so`/`.dylib` out of
 * a `natives-*.jar` (a ZIP), skipping META-INF and non-native files.
 */
import { describe, it, expect } from "vitest";
import { extractNatives } from "../src/launch/unzip.js";
import { makeStoredZip } from "./_zip.js";

describe("extractNatives", () => {
  it("extracts native libs (flattened by basename) and skips everything else", () => {
    const zip = makeStoredZip([
      { name: "linux/x64/org/lwjgl/liblwjgl.so", data: Buffer.from("ELF-LWJGL") },
      { name: "glfw.dll", data: Buffer.from("MZ-GLFW") },
      { name: "darwin/libglfw.dylib", data: Buffer.from("MACHO") },
      { name: "META-INF/MANIFEST.MF", data: Buffer.from("Manifest-Version: 1.0") },
      { name: "module-info.class", data: Buffer.from("CAFEBABE") },
      { name: "readme.txt", data: Buffer.from("hello") },
    ]);

    const written = new Map<string, Buffer>();
    const names = extractNatives(zip, (name, data) => written.set(name, data));

    expect(names.sort()).toEqual(["glfw.dll", "liblwjgl.so", "libglfw.dylib"].sort());
    expect(written.get("liblwjgl.so")?.toString()).toBe("ELF-LWJGL");
    expect(written.get("glfw.dll")?.toString()).toBe("MZ-GLFW");
    expect(written.has("MANIFEST.MF")).toBe(false);
    expect(written.has("readme.txt")).toBe(false);
  });

  it("returns nothing for a jar with no natives", () => {
    const zip = makeStoredZip([{ name: "fabric.mod.json", data: Buffer.from("{}") }]);
    const written: string[] = [];
    expect(extractNatives(zip, (n) => written.push(n))).toEqual([]);
    expect(written).toEqual([]);
  });

  it("throws a clear error on a non-zip buffer", () => {
    expect(() => extractNatives(Buffer.from("not a zip"), () => {})).toThrow(/BAD_ZIP/);
  });
});
