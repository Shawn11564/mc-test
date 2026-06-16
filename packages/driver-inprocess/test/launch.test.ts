/**
 * Real offline launch-arg construction (pure). The build is a genuine
 * `java -cp … net.fabricmc.loader.impl.launch.knot.KnotClient …` invocation: it
 * carries offline-auth game args (deterministic username, zero UUID, zero access
 * token — never a Microsoft session token), points `-Djava.library.path` at the
 * extracted natives, joins the classpath with the TARGET platform's separator,
 * and threads MCTEST_AGENT_PORT + display env.
 */
import { describe, it, expect } from "vitest";
import { buildClientLaunch, type ResolvedClient } from "../src/launch/ClientLauncher.js";
import { selectDisplay } from "../src/launch/Display.js";

function fakeClient(platform: NodeJS.Platform = "linux"): ResolvedClient {
  return {
    mc: "1.21.1",
    loader: "fabric",
    loaderVersion: "0.16.5",
    javaPath: "/jdk/bin/java",
    mainClass: "net.fabricmc.loader.impl.launch.knot.KnotClient",
    classpath: ["/cache/libraries/a.jar", "/cache/libraries/b.jar", "/cache/versions/1.21.1/client.jar"],
    nativesDir: "/cache/natives/1.21.1-linux-x64",
    gameDir: "/work/inst",
    assetsDir: "/cache/assets",
    assetIndex: "17",
    platform,
  };
}

const xvfb = selectDisplay({ platform: "linux" });

describe("buildClientLaunch", () => {
  it("emits offline-auth game args and no Microsoft session token", () => {
    const { command, args } = buildClientLaunch({ client: fakeClient(), display: xvfb });
    expect(command).toBe("/jdk/bin/java");
    expect(args[args.indexOf("--username") + 1]).toBe("Tester");
    expect(args[args.indexOf("--uuid") + 1]).toBe("00000000-0000-0000-0000-000000000000");
    expect(args[args.indexOf("--accessToken") + 1]).toBe("0");
    expect(args[args.indexOf("--userType") + 1]).toBe("legacy");
    expect(args.join(" ")).not.toMatch(/sessionToken|msa|microsoft|xboxToken/i);
  });

  it("launches KnotClient against the real classpath + natives dir", () => {
    const client = fakeClient();
    const { args } = buildClientLaunch({ client, display: xvfb });
    // mainClass appears after the JVM args, before the game args (--username).
    const mainIdx = args.indexOf(client.mainClass);
    expect(mainIdx).toBeGreaterThan(0);
    expect(mainIdx).toBeLessThan(args.indexOf("--username"));
    // -cp carries every classpath entry, ':'-joined on linux.
    const cp = args[args.indexOf("-cp") + 1];
    expect(cp).toBe(client.classpath.join(":"));
    expect(args).toContain(`-Djava.library.path=${client.nativesDir}`);
    expect(args).toContain(`-Dorg.lwjgl.librarypath=${client.nativesDir}`);
    expect(args).toContain("-DFabricMcEmu=net.minecraft.client.main.Main");
    // game dir / assets are wired from the resolved client.
    expect(args[args.indexOf("--gameDir") + 1]).toBe(client.gameDir);
    expect(args[args.indexOf("--assetsDir") + 1]).toBe(client.assetsDir);
    expect(args[args.indexOf("--assetIndex") + 1]).toBe("17");
  });

  it("uses the TARGET platform's classpath separator", () => {
    const win = buildClientLaunch({ client: fakeClient("win32"), display: selectDisplay({ platform: "win32" }) });
    expect(win.args[win.args.indexOf("-cp") + 1]).toContain(";");
    const lin = buildClientLaunch({ client: fakeClient("linux"), display: xvfb });
    expect(lin.args[lin.args.indexOf("-cp") + 1]).toContain(":");
  });

  it("adds -XstartOnFirstThread only on macOS", () => {
    const mac = buildClientLaunch({ client: fakeClient("darwin"), display: selectDisplay({ platform: "darwin" }) });
    expect(mac.args).toContain("-XstartOnFirstThread");
    const lin = buildClientLaunch({ client: fakeClient("linux"), display: xvfb });
    expect(lin.args).not.toContain("-XstartOnFirstThread");
  });

  it("threads MCTEST_AGENT_PORT and the display env", () => {
    const { env } = buildClientLaunch({ client: fakeClient(), display: xvfb, agentPort: 25599 });
    expect(env["MCTEST_AGENT_PORT"]).toBe("25599");
    expect(env["DISPLAY"]).toBe(":99");
    expect(env["LIBGL_ALWAYS_SOFTWARE"]).toBe("1");
  });

  it("passes through the requested window size", () => {
    const { args } = buildClientLaunch({ client: fakeClient("win32"), display: selectDisplay({ platform: "win32" }), windowSize: "800x600" });
    expect(args[args.indexOf("--width") + 1]).toBe("800");
    expect(args[args.indexOf("--height") + 1]).toBe("600");
  });
});
