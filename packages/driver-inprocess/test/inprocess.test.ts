/**
 * InProcessDriver lifecycle with ALL real seams injected (no network, no display,
 * no client). Proves `start()` provisions with the right mods/agent jar, builds an
 * offline `java … KnotClient` launch, resolves to the spawner's url, allocates a
 * distinct agent port per instance, and that `stop()` tears down BOTH the client
 * and the managed display. The real launch (downloading MC+Fabric, scraping
 * `MCTP listening on :PORT` from a rendered client) runs in the GL-capable E2E lane.
 */
import { describe, it, expect, vi } from "vitest";
import { InProcessDriver, type ClientLaunch, type SpawnedClient } from "../src/InProcessDriver.js";
import { INPROCESS_CAPABILITY_KEYS } from "../src/capabilities.js";
import { selectDisplay, type DisplaySession } from "../src/launch/Display.js";
import type { ResolvedClient } from "../src/launch/ClientLauncher.js";
import type { ProvisionOptions } from "../src/launch/ClientProvisioner.js";

/** A fake provisioned client (no download) that echoes the staged mods/agent jar. */
function fakeClientFor(opts: ProvisionOptions): ResolvedClient {
  return {
    mc: opts.mc,
    loader: opts.loader ?? "fabric",
    loaderVersion: "0.16.5",
    javaPath: opts.javaPath ?? "java",
    mainClass: "net.fabricmc.loader.impl.launch.knot.KnotClient",
    classpath: ["/cache/libraries/x.jar", "/cache/versions/client.jar"],
    nativesDir: "/cache/natives",
    gameDir: "/work/inst",
    assetsDir: "/cache/assets",
    assetIndex: "17",
    platform: opts.platform ?? "linux",
  };
}

const fakeDisplay = async (): Promise<DisplaySession> => {
  const choice = selectDisplay({ platform: "linux" });
  return { choice, env: choice.env, stop: async () => {} };
};

describe("InProcessDriver (all seams injected)", () => {
  it("provisions with the SUT mods + agent jar and feeds the spawner an offline KnotClient launch", async () => {
    let provOpts: ProvisionOptions | undefined;
    let seen: ClientLaunch | undefined;
    const driver = new InProcessDriver({
      mc: "1.21.1",
      loader: "fabric",
      mods: ["/abs/regions.jar"],
      clientAgentJar: "/abs/agent-client-fabric.jar",
      display: "xvfb",
      startDisplaySession: fakeDisplay,
      provision: async (opts) => {
        provOpts = opts;
        return fakeClientFor(opts);
      },
      spawn: async (launch): Promise<SpawnedClient> => {
        seen = launch;
        return { url: "ws://127.0.0.1:25599/mctp", stop: async () => {} };
      },
    });

    const { url } = await driver.start();
    expect(url).toBe("ws://127.0.0.1:25599/mctp");
    expect(driver.endpoint).toBe("ws://127.0.0.1:25599/mctp");

    // The provisioner was asked to stage the SUT mod + the client agent jar.
    expect(provOpts?.mods).toEqual(["/abs/regions.jar"]);
    expect(provOpts?.clientAgentJar).toBe("/abs/agent-client-fabric.jar");

    // The spawner saw a real offline launch: KnotClient main + classpath + display env.
    expect(seen?.command).toBe("java");
    expect(seen?.args).toContain("net.fabricmc.loader.impl.launch.knot.KnotClient");
    expect(seen?.args).toContain("-cp");
    expect(seen?.args[seen.args.indexOf("--accessToken") + 1]).toBe("0");
    expect(seen?.env["DISPLAY"]).toBe(":99");
    expect(seen?.env["LIBGL_ALWAYS_SOFTWARE"]).toBe("1");

    await driver.stop();
  });

  it("allocates a distinct MCTEST_AGENT_PORT per instance (parallel isolation)", async () => {
    const seenPort = async (): Promise<string | undefined> => {
      let port: string | undefined;
      const driver = new InProcessDriver({
        startDisplaySession: fakeDisplay,
        provision: async (opts) => fakeClientFor(opts),
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
    expect(Number(a)).toBeGreaterThan(0);
    expect(Number(b)).toBeGreaterThan(0);
    expect(a).not.toBe(b);
  });

  it("honors an explicitly pinned agentPort", async () => {
    let port: string | undefined;
    const driver = new InProcessDriver({
      agentPort: 25731,
      startDisplaySession: fakeDisplay,
      provision: async (opts) => fakeClientFor(opts),
      spawn: async (launch): Promise<SpawnedClient> => {
        port = launch.env["MCTEST_AGENT_PORT"];
        return { url: "ws://127.0.0.1:25731/mctp", stop: async () => {} };
      },
    });
    await driver.start();
    expect(port).toBe("25731");
    await driver.stop();
  });

  it("stop() tears down BOTH the client and the managed display, idempotently", async () => {
    const stopClient = vi.fn(async () => {});
    const stopDisplay = vi.fn(async () => {});
    const driver = new InProcessDriver({
      startDisplaySession: async () => {
        const choice = selectDisplay({ platform: "linux" });
        return { choice, env: choice.env, stop: stopDisplay };
      },
      provision: async (opts) => fakeClientFor(opts),
      spawn: async (): Promise<SpawnedClient> => ({ url: "ws://127.0.0.1:1/mctp", stop: stopClient }),
    });
    await driver.start();
    await driver.stop();
    expect(stopClient).toHaveBeenCalledTimes(1);
    expect(stopDisplay).toHaveBeenCalledTimes(1);
    // A second stop is a no-op (idempotent teardown).
    await driver.stop();
    expect(stopClient).toHaveBeenCalledTimes(1);
    expect(stopDisplay).toHaveBeenCalledTimes(1);
  });

  it("advertises clientScreens + screenshot (the inprocess differentiators)", () => {
    expect(INPROCESS_CAPABILITY_KEYS).toContain("clientScreens");
    expect(INPROCESS_CAPABILITY_KEYS).toContain("screenshot");
    expect(INPROCESS_CAPABILITY_KEYS).toContain("rendering");
  });
});
