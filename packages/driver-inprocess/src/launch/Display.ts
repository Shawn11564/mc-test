/**
 * Display-backend selection for the rendered client (ROADMAP §8.2).
 *
 * Pure, unit-tested. A rendered Minecraft client needs a GL context; CI is
 * headless. On Linux we default to **Xvfb + software GL** (Mesa/llvmpipe); on a
 * desktop runner (win32/darwin, or an explicit `desktop` pref) we render
 * natively. An explicit `pref` always wins. No process spawning happens here —
 * the choice is consumed by `buildClientLaunch`/`InProcessDriver`.
 */

/** The display backends a rendered client can run under. */
export type DisplayBackend = "xvfb" | "desktop";

/** A resolved display choice: the backend, an optional `:N` display id, and the
 *  environment overlay the client process should inherit. */
export interface DisplayChoice {
  backend: DisplayBackend;
  display?: string;
  env: Record<string, string>;
}

/** Default X display id for the Xvfb path. */
const DEFAULT_XVFB_DISPLAY = ":99";

/**
 * Select the display backend for a rendered client.
 *
 * - An explicit `pref` wins (`xvfb` or `desktop`).
 * - Otherwise: `desktop` on win32/darwin, `xvfb` on linux (the CI path).
 *
 * The Xvfb path sets `DISPLAY` (default `:99`, overridable via `display`) plus
 * `LIBGL_ALWAYS_SOFTWARE=1` so Mesa/llvmpipe is used for a deterministic, GPU-free
 * frame. The desktop path adds no env overlay.
 */
export function selectDisplay(opts: {
  platform: NodeJS.Platform;
  pref?: DisplayBackend;
  display?: string;
}): DisplayChoice {
  const backend: DisplayBackend =
    opts.pref ?? (opts.platform === "linux" ? "xvfb" : "desktop");

  if (backend === "xvfb") {
    const display = opts.display ?? DEFAULT_XVFB_DISPLAY;
    return {
      backend,
      display,
      env: { DISPLAY: display, LIBGL_ALWAYS_SOFTWARE: "1" },
    };
  }

  return { backend, env: {} };
}
