/**
 * `@mc-test/driver-headless` — a Mineflayer protocol bot exposed as a real MCTP
 * WebSocket server. The default fast CI driver: drives server-driven container
 * GUIs, chat, and commands. Advertises chat/command/containerGui/typeText/pressKey.
 */
export { HeadlessDriver } from "./HeadlessDriver.js";
export {
  HEADLESS_CAPABILITIES,
  HEADLESS_CAPABILITY_KEYS,
  HEADLESS_AGENT_KIND,
} from "./capabilities.js";
export {
  resolveSelector,
  matchesSelector,
  primaryVia,
  type ResolvedElement,
  type ResolveOutcome,
} from "./primitives/selectorResolve.js";
export { normalize, flattenText, flattenComponent } from "./normalize.js";
