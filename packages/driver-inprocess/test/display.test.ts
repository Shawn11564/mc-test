/**
 * Display-backend selection (pure). win32/darwin render natively; linux defaults
 * to Xvfb + software GL; an explicit pref always wins.
 */
import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { selectDisplay, startDisplay, xvfbArgs, type XvfbSpawner } from "../src/launch/Display.js";

describe("selectDisplay", () => {
  it("renders natively (desktop) on win32 and darwin", () => {
    expect(selectDisplay({ platform: "win32" }).backend).toBe("desktop");
    expect(selectDisplay({ platform: "darwin" }).backend).toBe("desktop");
  });

  it("defaults to xvfb on linux (the CI path) with DISPLAY + software GL", () => {
    const choice = selectDisplay({ platform: "linux" });
    expect(choice.backend).toBe("xvfb");
    expect(choice.display).toBe(":99");
    expect(choice.env["DISPLAY"]).toBe(":99");
    expect(choice.env["LIBGL_ALWAYS_SOFTWARE"]).toBe("1");
  });

  it("honors an explicit display id on the xvfb path", () => {
    const choice = selectDisplay({ platform: "linux", display: ":42" });
    expect(choice.display).toBe(":42");
    expect(choice.env["DISPLAY"]).toBe(":42");
  });

  it("lets an explicit pref win over the platform default", () => {
    // Force Xvfb on a desktop OS…
    const forcedXvfb = selectDisplay({ platform: "win32", pref: "xvfb" });
    expect(forcedXvfb.backend).toBe("xvfb");
    expect(forcedXvfb.env["LIBGL_ALWAYS_SOFTWARE"]).toBe("1");
    // …and force desktop on linux (no env overlay).
    const forcedDesktop = selectDisplay({ platform: "linux", pref: "desktop" });
    expect(forcedDesktop.backend).toBe("desktop");
    expect(forcedDesktop.env).toEqual({});
  });
});

describe("xvfbArgs", () => {
  it("builds an Xvfb argv with software-friendly defaults + -displayfd readiness", () => {
    const args = xvfbArgs(":99", 1280, 720);
    expect(args).toEqual([":99", "-screen", "0", "1280x720x24", "-nolisten", "tcp", "-displayfd", "1"]);
  });
});

/** A fake Xvfb child: `kill()` emits `exit` so `stop()` resolves. */
function fakeChild(): EventEmitter & { kill: () => void } {
  const ee = new EventEmitter() as EventEmitter & { kill: () => void; stdout?: unknown };
  ee.kill = () => {
    ee.emit("exit", 0);
  };
  return ee;
}

describe("startDisplay (lifecycle)", () => {
  it("desktop → no-op session with no env overlay", async () => {
    const session = await startDisplay({ platform: "win32" });
    expect(session.choice.backend).toBe("desktop");
    expect(session.env).toEqual({});
    await session.stop();
  });

  it("xvfb with an ambient DISPLAY → reuses it (xvfb-run / desktop X) + software GL", async () => {
    let spawned = false;
    const spawn: XvfbSpawner = () => {
      spawned = true;
      return { child: fakeChild() as never, ready: Promise.resolve("0") };
    };
    const session = await startDisplay({ platform: "linux", existingDisplay: ":7", spawn });
    expect(spawned).toBe(false); // ambient display reused, no Xvfb spawned
    expect(session.env["DISPLAY"]).toBe(":7");
    expect(session.env["LIBGL_ALWAYS_SOFTWARE"]).toBe("1");
    await session.stop();
  });

  it("xvfb with no ambient display → spawns a managed Xvfb and learns its display", async () => {
    let sawArgs: string[] | undefined;
    const spawn: XvfbSpawner = (args) => {
      sawArgs = args;
      return { child: fakeChild() as never, ready: Promise.resolve("88") };
    };
    const session = await startDisplay({ platform: "linux", existingDisplay: undefined, spawn });
    expect(sawArgs?.[0]).toBe(":99"); // default display passed to Xvfb
    expect(session.env["DISPLAY"]).toBe(":88"); // learned from -displayfd
    expect(session.env["LIBGL_ALWAYS_SOFTWARE"]).toBe("1");
    await session.stop(); // kill() → exit → resolves
  });
});
