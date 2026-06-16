/**
 * Pixel/OCR driver (M5 stub) unit tests. Prove the advertised capability shape
 * (the universal last-resort surface + the advisory `brittle` flag, NO testIdTags
 * / server-truth caps) and that the unimplemented backend fails honestly rather
 * than faking a run. Capability-driven *selection* of the pixel driver as a last
 * resort is proven in the runner's `m5.test.ts` (it never launches the backend).
 */
import { describe, it, expect } from "vitest";
import { CAPABILITY_KEYS, matchCapabilities } from "@mc-test/protocol";
import {
  PixelDriver,
  PixelDriverNotImplementedError,
  PIXEL_CAPABILITIES,
  PIXEL_CAPABILITY_KEYS,
  PIXEL_AGENT_KIND,
} from "../src/index.js";

describe("pixel driver capabilities (M5)", () => {
  it("advertises the universal last-resort surface", () => {
    for (const key of ["chat", "command", "containerGui", "clientScreens", "screenshot", "rendering", "typeText", "pressKey"] as const) {
      expect(PIXEL_CAPABILITIES[key]).toBe(true);
    }
  });

  it("does NOT advertise testIdTags or the server-truth caps", () => {
    // Pixel sees only pixels — it cannot read invisible test tags…
    expect(PIXEL_CAPABILITIES.testIdTags).toBeUndefined();
    // …and server truth/fixtures/players belong to a paired server agent.
    expect(PIXEL_CAPABILITIES.worldTruth).toBeUndefined();
    expect(PIXEL_CAPABILITIES.pluginState).toBeUndefined();
    expect(PIXEL_CAPABILITIES.fixtures).toBeUndefined();
    expect(PIXEL_CAPABILITIES.fakePlayers).toBeUndefined();
  });

  it("carries the advisory `brittle` flag (and brittle is NOT a matchable capability)", () => {
    expect(PIXEL_CAPABILITIES.brittle).toBe(true);
    expect(CAPABILITY_KEYS).not.toContain("brittle");
    // A clientScreens test is satisfied by the pixel set; brittle does not gate it.
    expect(matchCapabilities({ clientScreens: true }, PIXEL_CAPABILITIES).ok).toBe(true);
  });

  it("is loader- and version-agnostic by construction", () => {
    expect(matchCapabilities({ loader: "neoforge" }, PIXEL_CAPABILITIES).ok).toBe(true);
    expect(matchCapabilities({ loader: "spigot" }, PIXEL_CAPABILITIES).ok).toBe(true);
    expect(matchCapabilities({ mcVersionRange: "1.8.9" }, PIXEL_CAPABILITIES).ok).toBe(true);
    expect(matchCapabilities({ mcVersionRange: "1.21.4" }, PIXEL_CAPABILITIES).ok).toBe(true);
  });

  it("agent.kind is pixelOcr and the key array matches the object set", () => {
    expect(PIXEL_AGENT_KIND).toBe("pixelOcr");
    for (const key of PIXEL_CAPABILITY_KEYS) expect(PIXEL_CAPABILITIES[key]).toBe(true);
  });
});

describe("pixel driver stub backend (M5)", () => {
  it("refuses to start (honest failure, never a fake run)", async () => {
    const driver = new PixelDriver({ mc: "1.21.1", loader: "fabric" });
    await expect(driver.start()).rejects.toBeInstanceOf(PixelDriverNotImplementedError);
  });

  it("stop() is a safe no-op", async () => {
    const driver = new PixelDriver();
    await expect(driver.stop()).resolves.toBeUndefined();
  });
});
