/**
 * The capability set the headless bot advertises.
 *
 * Per BUILD_PROMPT §M2 the headless driver advertises exactly:
 * `chat, command, containerGui, typeText, pressKey` — and NOT `screenshot`,
 * `clientScreens`, `rendering`, `worldTruth`, `pluginState`, `fixtures`, or
 * `fakePlayers`. Tests requiring an unadvertised capability skip on this driver
 * with reason `NO_COMPATIBLE_DRIVER`.
 */
import type { Capabilities, CapabilityKey } from "@mc-test/protocol";

/** The advertised capability keys (array form, for `session.create` results). */
export const HEADLESS_CAPABILITY_KEYS: CapabilityKey[] = [
  "chat",
  "command",
  "containerGui",
  "typeText",
  "pressKey",
];

/** The advertised capability set (object form, for `matchCapabilities`). */
export const HEADLESS_CAPABILITIES: Capabilities = {
  chat: true,
  command: true,
  containerGui: true,
  typeText: true,
  pressKey: true,
  loader: ["paper", "spigot", "folia"],
  // Mineflayer + minecraft-data span a wide range; pinned generously for M2.
  mcVersionRange: ">=1.8 <=1.21.4",
};

/** The MCTP `agent.kind` for this driver. */
export const HEADLESS_AGENT_KIND = "headlessBot" as const;
