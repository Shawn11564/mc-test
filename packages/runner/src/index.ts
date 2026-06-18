/**
 * `@mc-test/runner` — the MCTP client/orchestrator. Public surface: the fluent
 * authoring API, the engine (`Runner`, `Session`, `SelectorWaits`,
 * capability matching), driver selection, config loaders, the JUnit reporter,
 * and the minimal Paper provisioner.
 */
export { test, FluentTest } from "./authoring/fluent.js";
export { Runner } from "./engine/Runner.js";
export type { ProvisionHandle, TargetMeta, AgentConn } from "./engine/Runner.js";
export { SessionGroup, type ConnDef } from "./engine/SessionGroup.js";
export {
  DriverRegistry,
  defaultRegistry,
  SERVER_DRIVER_CAPABILITIES,
  SERVER_DRIVER_SENTINEL,
  type DriverDescriptor,
  type DriverHandle,
  type DriverLaunchContext,
  type SelectionResult,
} from "./drivers/DriverRegistry.js";
export { MctpClient, MctpRpcError } from "./drivers/MctpClient.js";
export { Session } from "./engine/Session.js";
export { withSelectorWaits, type SelectorWaitOptions } from "./engine/SelectorWaits.js";
export {
  matchCapabilities,
  requiredKeys,
  advertisedKeys,
  capsFromKeys,
} from "./engine/CapabilityMatch.js";
export type { Capabilities, RequiredCapabilities, CapabilityKey } from "@mc-test/protocol";
export {
  executeStep,
  VERB_CAPABILITY,
  singleSessionRouter,
  type ExecContext,
  type SessionRouter,
  type StepCapReq,
} from "./engine/StepExecutor.js";
export { stepCapMatch } from "./engine/CapabilityMatch.js";
export { loadSteps, parseStepDocument } from "./config/loadSteps.js";
export { loadMatrix, parseMatrix, findTarget, resolveWorld } from "./config/loadMatrix.js";
export { renderJUnit, writeJUnit } from "./report/JUnitReporter.js";
export {
  buildSkipMatrix,
  renderSkipMatrix,
  type SkipMatrix,
  type SkipCell,
} from "./report/SkipMatrix.js";
export { collectArtifacts, artifactDirFor, baselineDirFor } from "./report/Artifacts.js";
export {
  decodePng,
  comparePng,
  isDecoded,
  type DecodedPng,
  type DecodeResult,
  type PngComparison,
} from "./report/pngDiff.js";
export {
  captureScreenshot,
  tryCaptureOnFailure,
  diffAgainstBaseline,
  type ScreenshotArtifact,
  type ScreenshotCaller,
  type CaptureOptions,
  type BaselineDiff,
} from "./report/screenshots.js";
export {
  provisionPaper,
  resolvePaperJar,
  resolveMojangServerJar,
  findFreePort,
  type PaperProvisionOptions,
  type ProvisionedServer,
  type AgentSpec,
  type AgentEndpoint,
} from "./provision/PaperProvisioner.js";
export { provisionServer, type ServerProvisionOptions } from "./provision/provisionServer.js";
export {
  provisionModded,
  loaderFamily,
  fabricServerLauncherUrl,
  loaderInstallerMaven,
  findArgsFile,
  type ModdedProvisionOptions,
  type ModSpec,
  type ServerLoaderFamily,
} from "./provision/ModdedProvisioner.js";
export { parseLoadedMods, modLoadResult, type ModLoad } from "./provision/serverCommon.js";
export { resolveModrinth, type ModrinthRef } from "./provision/modrinth.js";
export type { NormalizedTest, NormalizedStep } from "./model/Step.js";
export type { MatrixFile, MatrixTarget, WorldDef, Source, ProvisionPolicy } from "./model/Target.js";
export type { TestResult, StepResult, SuiteResult, SkipInfo, Outcome, BaselineDiffInfo } from "./model/result.js";
