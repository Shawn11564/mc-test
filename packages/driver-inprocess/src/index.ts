/**
 * `@mc-test/driver-inprocess` — the runner-side adapter that launches and
 * babysits a **rendered Minecraft client** hosting the client MCTP agent
 * (`client-fabric` et al.). The only driver that can read/operate real,
 * client-rendered mod Screens/widgets (`clientScreens`) — the one thing the
 * headless bot fundamentally cannot see. Advertises clientScreens/containerGui/
 * chat/command/typeText/pressKey/testIdTags + screenshot/rendering.
 */
export {
  InProcessDriver,
  type InProcessLaunchOptions,
  type SpawnedClient,
  type ClientLaunch,
} from "./InProcessDriver.js";
export {
  INPROCESS_CAPABILITIES,
  INPROCESS_CAPABILITY_KEYS,
  INPROCESS_AGENT_KIND,
} from "./capabilities.js";
export {
  selectDisplay,
  type DisplayBackend,
  type DisplayChoice,
} from "./launch/Display.js";
export {
  buildClientLaunch,
  type ClientLaunchSpec,
} from "./launch/ClientLauncher.js";
