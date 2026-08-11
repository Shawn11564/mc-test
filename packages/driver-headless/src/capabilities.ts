/**
 * The capability set the headless bot advertises.
 *
 * Per BUILD_PROMPT §M2 the headless driver advertises
 * `chat, command, containerGui, typeText, pressKey` — plus `worldInteraction`
 * (phase 2): a protocol bot acts on the world as a real player (use/attack a
 * block face, hold an item, look, move), which is exactly what Mineflayer's
 * `activateBlock`/`dig`/`equip`/`look`/`setControlState` give us.
 *
 * It still does NOT advertise `screenshot`, `clientScreens`, `rendering`,
 * `worldTruth`, `pluginState`, `fixtures`, or `fakePlayers` — note in particular
 * that `worldInteraction` (ACT as the player) is a different thing from
 * `worldTruth` (READ authoritative server state), which stays the server agent's.
 * Tests requiring an unadvertised capability skip on this driver with reason
 * `NO_COMPATIBLE_DRIVER`.
 */
import type { Capabilities, CapabilityKey } from "@mc-test/protocol";

/** The advertised capability keys (array form, for `session.create` results). */
export const HEADLESS_CAPABILITY_KEYS: CapabilityKey[] = [
  "chat",
  "command",
  "containerGui",
  "typeText",
  "pressKey",
  "worldInteraction",
];

/** The advertised capability set (object form, for `matchCapabilities`). */
export const HEADLESS_CAPABILITIES: Capabilities = {
  chat: true,
  command: true,
  containerGui: true,
  typeText: true,
  pressKey: true,
  worldInteraction: true,
  // A vanilla-protocol Mineflayer bot connects to Bukkit-family servers AND to a
  // Fabric/Quilt server (those accept vanilla clients by default — server-side mods
  // don't change the login handshake). NOT forge/neoforge: their FML login handshake
  // a vanilla bot cannot complete, so those modded servers are driven by the cost-1
  // `server` truth driver (no player join), never the headless bot (F5).
  loader: ["paper", "spigot", "folia", "fabric", "quilt"],
  // Mineflayer + minecraft-data span a wide range; pinned generously for M2.
  mcVersionRange: ">=1.8 <=1.21.4",
};

/** The MCTP `agent.kind` for this driver. */
export const HEADLESS_AGENT_KIND = "headlessBot" as const;
