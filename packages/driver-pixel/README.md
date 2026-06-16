# @mc-test/driver-pixel

The **pixel/OCR driver** (M5 stub) — mc-test's universal **last-resort** visual
driver. It treats the screen as raw framebuffer pixels and resolves semantic
selectors visually (OCR + template matching) with OS-level mouse/keyboard input.
Because pixels do not care about the wire protocol version or obfuscation
mappings, it spans **every loader and MC version by construction** — at the cost
of being slow and brittle.

> Driver cost order (cheapest → costliest, CAPABILITIES.md §7):
> **server < headless < inprocess < pixel**. The pixel driver is **always last**.

## What it advertises

`chat`, `command`, `containerGui`, `clientScreens`, `screenshot`, `rendering`,
`typeText`, `pressKey` — a near-universal surface — at **cost 4**, plus the
advisory **`brittle: true`** descriptor (PROTOCOL.md §6.1). Because it is the
costliest driver, the runner only ever selects it when **no** structural driver
(server / headless / inprocess) satisfies the test. `brittle` is **not** a
matchable capability (it is excluded from `CAPABILITY_KEYS`), so a test cannot
"require" it — the runner reads it solely to emit a **loud report note** when the
pixel driver is chosen.

It does **not** advertise `testIdTags` (it sees only pixels — it cannot read the
invisible `mc-test:test_id` tags) nor the server-truth caps
(`worldTruth`/`pluginState`/`fixtures`/`fakePlayers`); those belong to a paired
server agent (e.g. `server-bukkit`), exactly as with the other client drivers. A
truth/pluginState step with no co-selected server agent **honestly skips**
(`NO_COMPATIBLE_DRIVER unmet:[…]`) — never a false pass.

## Status: a selectable stub

The **visual backend** (framebuffer capture + OCR/template selector resolution +
OS-level input, via tesseract/opencv/nut-js — DRIVERS.md §4.4) is **not
implemented** in this build. The driver is registered purely so capability
negotiation can fall to it as the documented last resort; selection reads only
the advertised capabilities and never calls `start()`. An attempt to actually
launch it throws `PixelDriverNotImplementedError` — honest failure over a false
green (CLAUDE.md Prime Directive 4).

## Versioning model

A pixel driver achieves version independence by construction: the per-version
cost lives in **OCR/template asset packs** keyed by `{ mcVersion, resourcePack,
guiScale }`, not in a recompile. Contrast the structural client/server agents,
which pay the obfuscation-mapping tax and rebuild per `(loader × mc)`.

## Use in the matrix

Selectable via `driver: pixel` in `mc-test.yml`, or chosen automatically as the
last resort when a test's required capabilities are met by nothing cheaper. See
`docs/DRIVERS.md` §4 and `docs/CAPABILITIES.md` §7.
