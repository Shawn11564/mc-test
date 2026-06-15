/**
 * Offline launch-arg construction (pure). The build must carry offline-auth flags
 * (deterministic username, zero UUID, zero access token), inject the SUT mods +
 * the client agent jar, thread MCTEST_AGENT_PORT + display env — and never a
 * Microsoft/Mojang session token.
 */
import { describe, it, expect } from "vitest";
import { buildClientLaunch } from "../src/launch/ClientLauncher.js";
import { selectDisplay } from "../src/launch/Display.js";

const xvfb = selectDisplay({ platform: "linux" });

describe("buildClientLaunch", () => {
  it("emits offline-auth flags and no Microsoft session token", () => {
    const { command, args } = buildClientLaunch({
      mc: "1.21.1",
      loader: "fabric",
      mods: [],
      display: xvfb,
    });
    expect(command).toBe("java");
    expect(args).toContain("--username");
    expect(args[args.indexOf("--username") + 1]).toBe("Tester");
    expect(args).toContain("--uuid");
    expect(args[args.indexOf("--uuid") + 1]).toBe("00000000-0000-0000-0000-000000000000");
    expect(args).toContain("--accessToken");
    expect(args[args.indexOf("--accessToken") + 1]).toBe("0");
    // No real auth tokens anywhere.
    expect(args.join(" ")).not.toMatch(/sessionToken|msa|microsoft|xboxToken/i);
  });

  it("injects the SUT mods plus the client agent jar", () => {
    const { args } = buildClientLaunch({
      mc: "1.21.1",
      loader: "fabric",
      mods: ["regions.jar"],
      clientAgentJar: "agent-client-fabric.jar",
      display: xvfb,
    });
    const modArgs = args.filter((_, i) => args[i - 1] === "--mctest-mod");
    expect(modArgs).toContain("regions.jar");
    expect(modArgs).toContain("agent-client-fabric.jar");
  });

  it("threads MCTEST_AGENT_PORT and the display env", () => {
    const { env } = buildClientLaunch({
      mc: "1.21.1",
      loader: "fabric",
      mods: [],
      agentPort: 25599,
      display: xvfb,
    });
    expect(env["MCTEST_AGENT_PORT"]).toBe("25599");
    expect(env["DISPLAY"]).toBe(":99");
    expect(env["LIBGL_ALWAYS_SOFTWARE"]).toBe("1");
  });

  it("passes through the requested window size", () => {
    const { args } = buildClientLaunch({
      mc: "1.21.1",
      loader: "fabric",
      mods: [],
      windowSize: "800x600",
      display: selectDisplay({ platform: "win32" }),
    });
    expect(args[args.indexOf("--width") + 1]).toBe("800");
    expect(args[args.indexOf("--height") + 1]).toBe("600");
  });
});
