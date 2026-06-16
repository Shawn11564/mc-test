/**
 * The capability set the pixel/OCR driver advertises (M5).
 *
 * The pixel driver is the **universal last resort** (DRIVERS.md §4): it treats
 * the screen as raw framebuffer pixels and resolves semantic selectors visually
 * (OCR + template matching) with OS-level mouse/keyboard input. Because pixels do
 * not care about the protocol version or obfuscation mappings, it spans every
 * loader and version *by construction* — at the cost of being slow and brittle.
 *
 * It therefore advertises a near-universal surface — `chat`, `command`,
 * `containerGui`, `clientScreens`, `screenshot`, `rendering`, `typeText`,
 * `pressKey` — but at the **highest cost** (4), so the runner only ever selects
 * it when no cheaper, structural driver (server < headless < inprocess) satisfies
 * the test. The advisory `brittle: true` descriptor (PROTOCOL.md §6.1) marks the
 * advertisement as last-resort; it is NOT a matchable capability (it never
 * appears in `CAPABILITY_KEYS`), so a test cannot require it — the runner reads it
 * only to emit a loud report note when this driver is chosen.
 *
 * It does NOT advertise `testIdTags` (pixel cannot read invisible test tags — it
 * sees only pixels) nor the server-truth caps (`worldTruth`/`pluginState`/
 * `fixtures`/`fakePlayers`) — those belong to a paired server agent, exactly as
 * for the other client drivers.
 */
import type { Capabilities, CapabilityKey } from "@mc-test/protocol";

/** The advertised capability keys (array form, for `session.create` results). */
export const PIXEL_CAPABILITY_KEYS: CapabilityKey[] = [
  "chat",
  "command",
  "containerGui",
  "clientScreens",
  "screenshot",
  "rendering",
  "typeText",
  "pressKey",
];

/**
 * The advertised capability set (object form, for `matchCapabilities`).
 *
 * `loader`/`mcVersionRange` are deliberately wide: a pixel driver is loader- and
 * version-agnostic (the per-version cost moves into OCR/template packs keyed by
 * `{ mcVersion, resourcePack, guiScale }`, not a recompile). `brittle: true` is
 * the advisory last-resort marker the runner surfaces in its report.
 */
export const PIXEL_CAPABILITIES: Capabilities = {
  chat: true,
  command: true,
  containerGui: true,
  clientScreens: true,
  screenshot: true,
  rendering: true,
  typeText: true,
  pressKey: true,
  // Loader- and version-agnostic by construction (pixels don't care).
  loader: ["spigot", "paper", "folia", "fabric", "forge", "neoforge", "quilt", "vanilla"],
  mcVersionRange: ">=1.8",
  // Advisory quality descriptor — last-resort, OCR/template-resolved selectors.
  brittle: true,
};

/** The MCTP `agent.kind` for the pixel/OCR driver. */
export const PIXEL_AGENT_KIND = "pixelOcr" as const;
