/**
 * Display-backend selection + lifecycle for the rendered client (ROADMAP §8.2).
 *
 * A rendered Minecraft client needs a GL context; CI is headless. On Linux we
 * default to **Xvfb + software GL** (Mesa/llvmpipe); on a desktop runner
 * (win32/darwin, or an explicit `desktop` pref) we render natively. An explicit
 * `pref` always wins.
 *
 * `selectDisplay` is PURE (unit-tested). `startDisplay` is the lifecycle: on the
 * Xvfb path it reuses an ambient `DISPLAY` when present (e.g. under `xvfb-run` or
 * a desktop X server) and otherwise spawns a managed `Xvfb`, learning the chosen
 * display from `-displayfd` (a real readiness signal, not a fixed sleep). The
 * spawner is injectable so the wiring is testable without an X server.
 */
import { spawn, type ChildProcess } from "node:child_process";

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

/** Build the `Xvfb` argv for a managed virtual display. `-displayfd 1` makes
 *  Xvfb pick/confirm a free display and print its number to stdout when ready. */
export function xvfbArgs(display: string, width: number, height: number): string[] {
  return [display, "-screen", "0", `${width}x${height}x24`, "-nolisten", "tcp", "-displayfd", "1"];
}

/** A started display: the env overlay to merge into the client + a teardown. */
export interface DisplaySession {
  choice: DisplayChoice;
  env: Record<string, string>;
  stop: () => Promise<void>;
}

/** Spawner shape (injectable). Returns the child + a promise of its ready DISPLAY. */
export type XvfbSpawner = (args: string[]) => { child: ChildProcess; ready: Promise<string> };

/**
 * Start (or reuse) a display for the rendered client.
 *
 * - `desktop` → no-op session (use the ambient display; none on headless win/mac).
 * - `xvfb` with an ambient `DISPLAY` (xvfb-run / desktop X) → reuse it + software GL.
 * - `xvfb` with no ambient display → spawn a managed `Xvfb`, wait for `-displayfd`.
 */
export async function startDisplay(opts: {
  platform: NodeJS.Platform;
  pref?: DisplayBackend;
  display?: string;
  width?: number;
  height?: number;
  /** Ambient display (defaults to `process.env.DISPLAY`); reused when set. */
  existingDisplay?: string | undefined;
  /** Injected Xvfb spawner (defaults to a real `Xvfb` child). */
  spawn?: XvfbSpawner;
}): Promise<DisplaySession> {
  const choice = selectDisplay({
    platform: opts.platform,
    ...(opts.pref ? { pref: opts.pref } : {}),
    ...(opts.display ? { display: opts.display } : {}),
  });

  if (choice.backend !== "xvfb") {
    return { choice, env: choice.env, stop: async () => {} };
  }

  const ambient = opts.existingDisplay ?? process.env.DISPLAY;
  if (ambient) {
    // Reuse the display already provided (xvfb-run wraps us / a desktop X exists).
    const env = { DISPLAY: ambient, LIBGL_ALWAYS_SOFTWARE: "1" };
    return { choice: { ...choice, display: ambient, env }, env, stop: async () => {} };
  }

  const spawner = opts.spawn ?? defaultXvfbSpawner;
  const display = choice.display ?? DEFAULT_XVFB_DISPLAY;
  try {
    const { child, ready } = spawner(xvfbArgs(display, opts.width ?? 1280, opts.height ?? 720));
    const num = await ready;
    const resolved = num.startsWith(":") ? num : `:${num}`;
    const env = { DISPLAY: resolved, LIBGL_ALWAYS_SOFTWARE: "1" };
    return {
      choice: { ...choice, display: resolved, env },
      env,
      stop: async () =>
        new Promise<void>((resolve) => {
          child.once("exit", () => resolve());
          child.kill();
        }),
    };
  } catch (err) {
    // Xvfb isn't available — e.g. a desktop OS that has no Xvfb binary (Windows/macOS), or a Linux
    // box that lacks it. Rather than failing the boot with `spawn Xvfb ENOENT`, fall back to rendering
    // on the native desktop display. (Selection still honors the explicit `xvfb` pref per its contract;
    // this is a runtime safety net so a `display: xvfb` matrix row also runs on a real desktop.)
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[mc-test] Xvfb unavailable (${reason}); falling back to the desktop display.`);
    const desktop: DisplayChoice = { backend: "desktop", env: {} };
    return { choice: desktop, env: desktop.env, stop: async () => {} };
  }
}

/** Real `Xvfb` spawner: reads the chosen display number from `-displayfd` (stdout). */
const defaultXvfbSpawner: XvfbSpawner = (args) => {
  const child = spawn("Xvfb", args, { stdio: ["ignore", "pipe", "pipe"] });
  const ready = new Promise<string>((resolve, reject) => {
    let buf = "";
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString();
      const m = /(\d+)/.exec(buf.trim());
      if (m && m[1]) {
        child.stdout?.off("data", onData);
        resolve(m[1]);
      }
    };
    child.stdout?.on("data", onData);
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`Xvfb exited before ready (code ${code ?? "?"})`)));
  });
  return { child, ready };
};
