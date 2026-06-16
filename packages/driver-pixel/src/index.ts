/**
 * `@mc-test/driver-pixel` — the pixel/OCR driver (M5 stub): the universal
 * LAST-RESORT visual driver. It resolves semantic selectors by OCR + template
 * matching over raw framebuffer pixels with OS-level input, so it spans every
 * loader and MC version by construction — at the cost of being slow and brittle.
 * Registered in the runner's `DriverRegistry` at the highest cost (4) and chosen
 * only when no structural driver fits; advertises the advisory `brittle` flag so
 * the runner emits a loud report note. The visual backend itself is unimplemented
 * in this build (the driver is registered for capability negotiation only).
 */
export {
  PixelDriver,
  PixelDriverNotImplementedError,
  type PixelLaunchOptions,
} from "./PixelDriver.js";
export {
  PIXEL_CAPABILITIES,
  PIXEL_CAPABILITY_KEYS,
  PIXEL_AGENT_KIND,
} from "./capabilities.js";
