/**
 * InProcessDriver lifecycle with an injected spawn stub (NO real client). Proves
 * `start()` resolves to the stub's url, the stub receives the built offline
 * launch, and `stop()` tears the stub down. The real launch (scraping
 * `MCTP listening on :PORT` from a rendered client) is acceptance-only.
 */
import { describe, it, expect, vi } from "vitest";
import { InProcessDriver, type ClientLaunch, type SpawnedClient } from "../src/InProcessDriver.js";
import { INPROCESS_CAPABILITY_KEYS } from "../src/capabilities.js";

describe("InProcessDriver (injected spawn)", () => {
  it("start() resolves to the stub url and feeds it the offline launch", async () => {
    let seen: ClientLaunch | undefined;
    const driver = new InProcessDriver({
      mc: "1.21.1",
      loader: "fabric",
      mods: ["regions.jar"],
      clientAgentJar: "agent-client-fabric.jar",
      display: "xvfb",
      spawn: async (launch): Promise<SpawnedClient> => {
        seen = launch;
        return { url: "ws://127.0.0.1:25599/mctp", stop: async () => {} };
      },
    });

    const { url } = await driver.start();
    expect(url).toBe("ws://127.0.0.1:25599/mctp");
    expect(driver.endpoint).toBe("ws://127.0.0.1:25599/mctp");

    // The stub saw an offline launch with the mods + agent jar + display env.
    expect(seen?.command).toBe("java");
    expect(seen?.args).toContain("agent-client-fabric.jar");
    expect(seen?.args).toContain("regions.jar");
    expect(seen?.env["DISPLAY"]).toBe(":99");
    expect(seen?.env["LIBGL_ALWAYS_SOFTWARE"]).toBe("1");

    await driver.stop();
  });

  it("allocates a distinct MCTEST_AGENT_PORT per instance (parallel isolation)", async () => {
    const seenPort = async (): Promise<string | undefined> => {
      let port: string | undefined;
      const driver = new InProcessDriver({
        spawn: async (launch): Promise<SpawnedClient> => {
          port = launch.env["MCTEST_AGENT_PORT"];
          return { url: "ws://127.0.0.1:1/mctp", stop: async () => {} };
        },
      });
      await driver.start();
      await driver.stop();
      return port;
    };

    const a = await seenPort();
    const b = await seenPort();
    // The env var is always set (so the client never falls back to its fixed default)…
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(Number(a)).toBeGreaterThan(0);
    // …and two instances get different ports so concurrent targets don't collide.
    expect(a).not.toBe(b);
  });

  it("honors an explicitly pinned agentPort", async () => {
    let port: string | undefined;
    const driver = new InProcessDriver({
      agentPort: 25731,
      spawn: async (launch): Promise<SpawnedClient> => {
        port = launch.env["MCTEST_AGENT_PORT"];
        return { url: "ws://127.0.0.1:25731/mctp", stop: async () => {} };
      },
    });
    await driver.start();
    expect(port).toBe("25731");
    await driver.stop();
  });

  it("stop() calls the stub's stop()", async () => {
    const stop = vi.fn(async () => {});
    const driver = new InProcessDriver({
      spawn: async (): Promise<SpawnedClient> => ({ url: "ws://127.0.0.1:1/mctp", stop }),
    });
    await driver.start();
    await driver.stop();
    expect(stop).toHaveBeenCalledTimes(1);
    // A second stop is a no-op (idempotent teardown).
    await driver.stop();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("advertises clientScreens + screenshot (the inprocess differentiators)", () => {
    expect(INPROCESS_CAPABILITY_KEYS).toContain("clientScreens");
    expect(INPROCESS_CAPABILITY_KEYS).toContain("screenshot");
    expect(INPROCESS_CAPABILITY_KEYS).toContain("rendering");
  });
});
