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
  type SpawnContext,
} from "./InProcessDriver.js";
export {
  INPROCESS_CAPABILITIES,
  INPROCESS_CAPABILITY_KEYS,
  INPROCESS_AGENT_KIND,
} from "./capabilities.js";
export {
  selectDisplay,
  startDisplay,
  xvfbArgs,
  type DisplayBackend,
  type DisplayChoice,
  type DisplaySession,
  type XvfbSpawner,
} from "./launch/Display.js";
export {
  buildClientLaunch,
  type BuildLaunchInput,
  type ResolvedClient,
  type OfflineIdentity,
} from "./launch/ClientLauncher.js";
export {
  provisionClient,
  type ProvisionOptions,
} from "./launch/ClientProvisioner.js";
export {
  pickVersion,
  selectLibraries,
  fabricLibraries,
  pickFabricLoader,
  assetDownloads,
  parseMaven,
  mavenPath,
  mavenUrl,
  ruleAllows,
  mojangOs,
  type VersionManifest,
  type VersionJson,
  type FabricProfile,
  type ResolvedArtifact,
} from "./launch/resolve.js";
export { extractNatives } from "./launch/unzip.js";
