import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acceptableJavaRange,
  requiredJavaMajor,
  parseJavaVersionMajor,
  javaBin,
  resolveJavaForMc,
  resolveJdk,
} from "../src/provision/jdk.js";

describe("multi-JDK — mc → Java major", () => {
  it("maps legacy versions to Java 8 (range 8–11)", () => {
    for (const mc of ["1.8.9", "1.12.2", "1.16.5"]) {
      expect(requiredJavaMajor(mc)).toBe(8);
      expect(acceptableJavaRange(mc)).toEqual({ min: 8, max: 11 });
    }
  });

  it("fetches an LTS: 1.17–1.20.4 → 17, 1.20.5+ → 21 (host-fit range for 1.17 still allows 16)", () => {
    expect(acceptableJavaRange("1.17.1")).toEqual({ min: 16, max: 17 });
    expect(requiredJavaMajor("1.17.1")).toBe(17);
    expect(requiredJavaMajor("1.18.2")).toBe(17);
    expect(requiredJavaMajor("1.20.4")).toBe(17);
    expect(requiredJavaMajor("1.20.6")).toBe(21);
    expect(requiredJavaMajor("1.21")).toBe(21);
    expect(requiredJavaMajor("1.21.4")).toBe(21);
  });
});

describe("multi-JDK — java -version parsing", () => {
  it("parses legacy 1.8 and modern majors", () => {
    expect(parseJavaVersionMajor('openjdk version "1.8.0_402"')).toBe(8);
    expect(parseJavaVersionMajor('openjdk version "11.0.22" 2024-01-16')).toBe(11);
    expect(parseJavaVersionMajor('openjdk version "17.0.10" 2024-01-16 LTS')).toBe(17);
    expect(parseJavaVersionMajor('java version "21.0.4" 2024-07-16 LTS')).toBe(21);
  });

  it("returns undefined for unparseable output", () => {
    expect(parseJavaVersionMajor("no version here")).toBeUndefined();
  });
});

describe("multi-JDK — resolveJavaForMc host preference", () => {
  const cacheDir = mkdtempSync(join(tmpdir(), "mctest-jdk-"));

  it("uses the host java when it satisfies the version (no download)", async () => {
    // Host Java 21 boots 1.18–1.20.4 (range [17,99]) directly — modern targets are unchanged.
    await expect(resolveJavaForMc("1.20.4", { cacheDir, hostJavaMajor: 21, download: false })).resolves.toBe(
      "java",
    );
  });

  it("does NOT boot a legacy server on host java 21; fails honestly when download is off", async () => {
    // 1.8.9 needs Java 8–11; host 21 is out of range. With download disabled and nothing configured,
    // it surfaces a precise JDK_NOT_AVAILABLE rather than booting the wrong Java.
    await expect(resolveJavaForMc("1.8.9", { cacheDir, hostJavaMajor: 21, download: false })).rejects.toThrow(
      /JDK_NOT_AVAILABLE/,
    );
  });

  it("honors an explicitly configured JDK home for the required major", async () => {
    const home = mkdtempSync(join(tmpdir(), "mctest-jdk8-"));
    mkdirSync(join(home, "bin"), { recursive: true });
    writeFileSync(javaBin(home), "");
    const got = await resolveJdk(8, { cacheDir, configured: { "8": home }, download: false });
    expect(got).toBe(javaBin(home));
  });
});
