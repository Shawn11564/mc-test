/**
 * Display-backend selection (pure). win32/darwin render natively; linux defaults
 * to Xvfb + software GL; an explicit pref always wins.
 */
import { describe, it, expect } from "vitest";
import { selectDisplay } from "../src/launch/Display.js";

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
