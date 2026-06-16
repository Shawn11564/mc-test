/**
 * Capability-keyed driver selection. The engine NEVER hard-codes "use headless";
 * it asks the registry for the cheapest driver whose advertised capabilities
 * satisfy the test's requirements (or learns nothing satisfies → skip).
 *
 * The actual driver implementation (Mineflayer) is imported lazily in
 * `create()`, so selecting/registering does not pull the heavy dependency.
 */
import { matchCapabilities, type Capabilities, type RequiredCapabilities } from "@mc-test/protocol";
import { HEADLESS_CAPABILITIES } from "@mc-test/driver-headless/capabilities";
import { INPROCESS_CAPABILITIES } from "@mc-test/driver-inprocess/capabilities";
import { PIXEL_CAPABILITIES } from "@mc-test/driver-pixel/capabilities";

/** A started driver: its MCTP endpoint URL and a teardown hook. */
export interface DriverHandle {
  url: string;
  stop: () => Promise<void>;
}

/**
 * Launch context for drivers that spawn an external process (M4). The in-process
 * driver uses it to launch the rendered client: which MC/loader, the display
 * backend (Xvfb in CI / desktop locally), the SUT mods + the client-agent jar to
 * inject. Drivers that need no launch (e.g. headless) ignore it.
 */
export interface DriverLaunchContext {
  mc?: string;
  loader?: string;
  display?: "xvfb" | "desktop";
  mods?: string[];
  clientAgentJar?: string;
  windowSize?: string;
}

/** A registered driver candidate. */
export interface DriverDescriptor {
  id: string;
  kind: string;
  /** Cost order (cheapest first): server < headless < inprocess < pixel. */
  cost: number;
  advertised: Capabilities;
  /**
   * Start the driver, returning its MCTP endpoint + teardown. `ctx` carries the
   * launch context for process-spawning drivers (M4 in-process); back-compat
   * drivers (headless) take no argument and ignore it.
   */
  create: (ctx?: DriverLaunchContext) => Promise<DriverHandle>;
}

export interface SelectionResult {
  driver?: DriverDescriptor;
  unmet: string[];
}

/** Holds the configured drivers and selects among them by capability. */
export class DriverRegistry {
  private readonly drivers: DriverDescriptor[] = [];

  register(descriptor: DriverDescriptor): void {
    this.drivers.push(descriptor);
  }

  list(): readonly DriverDescriptor[] {
    return this.drivers;
  }

  /**
   * Pick the cheapest driver satisfying `required`. With a `pin`, only that
   * driver id is considered. Returns the aggregate `unmet[]` of the most-capable
   * candidate when nothing fits.
   */
  select(required: RequiredCapabilities, pin?: string): SelectionResult {
    const candidates = (pin ? this.drivers.filter((d) => d.id === pin) : this.drivers)
      .slice()
      .sort((a, b) => a.cost - b.cost);
    let bestUnmet: string[] = [];
    let fewest = Number.POSITIVE_INFINITY;
    for (const driver of candidates) {
      const match = matchCapabilities(required, driver.advertised);
      if (match.ok) return { driver, unmet: [] };
      if (match.unmet.length < fewest) {
        fewest = match.unmet.length;
        bestUnmet = match.unmet;
      }
    }
    return { unmet: bestUnmet };
  }
}

const HEADLESS_COST = 2; // server(1) < headless(2) < inprocess(3) < pixel(4)
const INPROCESS_COST = 3;
const PIXEL_COST = 4;

/**
 * The default registry (M2 + M4 + M5): the headless driver (cost 2), the
 * in-process rendered-client driver (cost 3), and the pixel/OCR driver (cost 4 —
 * the universal **last resort**). Selection is by cost — a `containerGui`-only
 * test still picks the cheaper headless; a `clientScreens` test pulls in the
 * in-process driver; and pixel is chosen **only** when nothing cheaper satisfies
 * the test (or it is explicitly pinned via `driver: pixel`). Every implementation
 * is lazy-imported in `create()` so registering pulls in no heavy dependency.
 */
export function defaultRegistry(): DriverRegistry {
  const registry = new DriverRegistry();
  registry.register({
    id: "headless",
    kind: "headlessBot",
    cost: HEADLESS_COST,
    advertised: HEADLESS_CAPABILITIES,
    create: async () => {
      const { HeadlessDriver } = await import("@mc-test/driver-headless");
      const driver = new HeadlessDriver();
      const { url } = await driver.start();
      return { url, stop: () => driver.stop() };
    },
  });
  registry.register({
    id: "inprocess",
    kind: "clientMod",
    cost: INPROCESS_COST,
    advertised: INPROCESS_CAPABILITIES,
    create: async (ctx) => {
      const { InProcessDriver } = await import("@mc-test/driver-inprocess");
      const driver = new InProcessDriver({ ...(ctx ?? {}) });
      const { url } = await driver.start();
      return { url, stop: () => driver.stop() };
    },
  });
  registry.register({
    id: "pixel",
    kind: "pixelOcr",
    cost: PIXEL_COST,
    advertised: PIXEL_CAPABILITIES,
    create: async (ctx) => {
      const { PixelDriver } = await import("@mc-test/driver-pixel");
      const driver = new PixelDriver({
        ...(ctx?.mc ? { mc: ctx.mc } : {}),
        ...(ctx?.loader ? { loader: ctx.loader } : {}),
        ...(ctx?.display ? { display: ctx.display } : {}),
      });
      const { url } = await driver.start(); // honest failure: the stub backend is unimplemented
      return { url, stop: () => driver.stop() };
    },
  });
  return registry;
}
