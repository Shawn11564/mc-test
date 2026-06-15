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

/** A started driver: its MCTP endpoint URL and a teardown hook. */
export interface DriverHandle {
  url: string;
  stop: () => Promise<void>;
}

/** A registered driver candidate. */
export interface DriverDescriptor {
  id: string;
  kind: string;
  /** Cost order (cheapest first): server < headless < inprocess < pixel. */
  cost: number;
  advertised: Capabilities;
  create: () => Promise<DriverHandle>;
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

/** The default registry for M2: just the headless driver. */
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
  return registry;
}
