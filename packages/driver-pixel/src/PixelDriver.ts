/**
 * The pixel/OCR driver (M5 STUB).
 *
 * The pixel driver is registered as a **selectable last-resort** so the runner's
 * capability negotiation can fall to it when no structural driver fits — but its
 * runtime backend (framebuffer capture + OCR/template selector resolution +
 * OS-level mouse/keyboard input, via tesseract/opencv/nut-js per DRIVERS.md §4.4)
 * is intentionally NOT implemented in this build. Selection only reads the
 * advertised capabilities (it never calls `start()`), so the stub is fully
 * functional for negotiation; an attempt to actually launch it fails **loudly and
 * honestly** rather than faking a green run.
 */

/** Options for a pixel/OCR launch (mirrors the other drivers' launch shape). */
export interface PixelLaunchOptions {
  mc?: string;
  loader?: string;
  display?: "xvfb" | "desktop";
  /** OCR/template asset pack keyed by `{ mcVersion, resourcePack, guiScale }`. */
  templatePack?: string;
  windowSize?: string;
}

/**
 * Thrown when something tries to actually `start()` the pixel driver. The pixel
 * driver is a registered-but-unimplemented last resort; honest failure beats a
 * false green (CLAUDE.md Prime Directive 4 — honest skips/failures over false
 * passes).
 */
export class PixelDriverNotImplementedError extends Error {
  override readonly name = "PixelDriverNotImplementedError";
  constructor() {
    super(
      "pixel driver is a stub: the OCR/template + OS-input backend (tesseract/opencv/nut-js) " +
        "is not implemented in this build. It is registered for capability negotiation only and " +
        "selected as the documented last resort (cost 4); it cannot be launched. See DRIVERS.md §4.",
    );
  }
}

/**
 * One pixel/OCR driver instance. Constructs cheaply (so the registry can carry
 * it) but refuses to `start()` — the visual backend is unimplemented.
 */
export class PixelDriver {
  private readonly opts: PixelLaunchOptions;

  constructor(opts: PixelLaunchOptions = {}) {
    this.opts = opts;
  }

  /** The launch options this instance was constructed with (diagnostics). */
  get options(): Readonly<PixelLaunchOptions> {
    return this.opts;
  }

  /**
   * Launch the visual driver — NOT implemented. Throws
   * {@link PixelDriverNotImplementedError}. Capability selection never calls this
   * (it reads only the advertised capabilities), so the stub stays selectable.
   */
  async start(): Promise<{ url: string }> {
    throw new PixelDriverNotImplementedError();
  }

  /** No-op teardown (nothing was ever started). */
  async stop(): Promise<void> {
    /* nothing to tear down — the stub never starts a backend */
  }
}
