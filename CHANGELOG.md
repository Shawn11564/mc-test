# Changelog

All notable changes to this project are recorded here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims to follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> mc-test is currently **internal/private** (decision **D1**, 2026-06-16): the `@mc-test/*` packages are
> not published to npm and the agent jars are not attached to GitHub Releases. Version tags are internal
> release markers. Revisit publishing for v2.

## [Unreleased]

### Added
- **Canonical OpenRegions SUT built for every target + richer behavior.** `examples/regions` now exists in
  **four forms** — the Bukkit/Paper [plugin](examples/regions/plugin) plus a **Fabric**, **Forge**, and
  **NeoForge** client mod (`examples/regions/mod-{fabric,forge,neoforge}`; the old `mod` is renamed to
  `mod-fabric`) — so every loader row in the matrix drives a **real** SUT instead of reusing the Fabric jar
  as a placeholder. Behavior is enriched from one button to a **CRUD flow**: a multi-region list (seeded
  `TestRegion`/`Spawn`/`Market`) with load, **create-by-typing** a name (mods) / a preset Create (plugin),
  delete, and richer queryable state (`regions.exists`/`count`/`list`/`active`). The Forge/NeoForge mods are
  plain mods with **zero mc-test coupling**, driven purely by `label` + `role` selectors; the Fabric mod
  additionally exposes `TestIdHolder` testIds. All four artifacts build on this Windows box
  (`regions-plugin.jar` via Maven; `openregions-{fabric,forge,neoforge}.jar` via Loom/ForgeGradle/NeoGradle,
  the Forge jar reobfuscated to SRG). (`examples/regions/**`, `mc-test.yml`, `tests/e2e/*.matrix.yml`,
  `.github/workflows/e2e.yml`.)
- **Tests + mock peers updated to the CRUD flow in lockstep.** `regions.mctest.yml` (headless) and
  `regions.clientgui.mctest.yml` (rendered — now selecting by `label` + `role:input`, so the SINGLE file
  runs unchanged across Fabric/Forge/NeoForge) drive the richer flow; `regions.fluent.test.ts` stays `≡`
  the YAML; the scripted mock agent and the F1/F3 e2e harness markers were updated to match. Full unit
  suite green: **393 tests** (incl. the 217 protocol conformance fixtures + the fluent≡YAML equivalence).
  The headless plugin path is **real-boot-verified**: `tests/e2e/run-real-boot.mjs` boots real Paper
  1.20.4, drives the enriched CRUD flow via a Mineflayer agent, and passes **5/5** — the positive run green
  including `assertPluginState` (active/exists/count from real state), plus the truth/UI-divergence (→RED)
  and capability-skip controls. The rendered **Fabric** client now **PASSES for real, fully off-screen** (a
  Linux container under Xvfb + Mesa software GL — see `scripts/run-rendered-docker.sh`): the client agent
  drives the SUT's client `Screen` end-to-end to a GREEN result — `/or` → screen "OpenRegions" → click
  "Regions" → **type** "Sanctuary" → Create → assertChat "Region created" → click "TestRegion" → assertChat
  "Region loaded" → assertPluginState `regions.exists = true` (real server state) — with `screenshot`
  honest-skipped, after the join→command race and capability-union fixes below. Forge/NeoForge
  rendered boots stay opt-in (`MC_TEST_RENDERED_LOADERS`) with their SUTs built + wired and the same agent
  fix applied; the multi-loader orchestration harness passes 4/4 (honest skips).
- **F2 — native old-version support (v2):** old Minecraft versions now run on the headless path
  *without* a proxy. The bot connects at the target's `mc` natively (Mineflayer + minecraft-data
  span ~1.8–1.21), and the provisioner boots an explicit, integrity-checked
  `server: { url | path, sha256 }` jar — so a plugin-capable old server the PaperMC fill API cannot
  serve (e.g. a Spigot 1.8.x jar) is supported. (`engine/viaPreflight.ts`, `PaperProvisioner`
  `serverJar`.)
- **Multi-JDK provisioning (v2):** the provisioner selects/fetches the right Java for a target's MC
  version, so legacy servers no longer fail on a modern host JDK. `mc` maps to an acceptable Java
  range; the host `java` is used when it fits, else a configured (`provision.jdks`) / installed JDK,
  else an Eclipse Temurin build fetched from Adoptium into the cache (`provision.downloadJdks`,
  default `true`) and spawned via `javaPath`. (`provision/jdk.ts`.) Validated end-to-end: Temurin 8
  fetched + extracted + `java -version`-verified on Windows.
- **Spigot BuildTools server source (v2):** `server: { spigot: { version } }` builds a plugin-capable
  legacy server from source with Spigot BuildTools (the Paper API can't serve 1.8.x), run under the
  version's JDK (multi-JDK supplies Java 8) — the automated counterpart to bring-your-own
  `server: { url | path, sha256 }`. Needs `git` + network; cached as `spigot-<rev>.jar` (the Spigot rev
  can differ from the MC version, e.g. 1.8.9 → 1.8.8; a bad rev fails fast `SPIGOT_VERSION_NOT_FOUND`).
  Adds a runnable `spigot-1.8.8` target. Validated end-to-end on Windows: BuildTools built Spigot 1.8.8
  from source under a fetched Temurin 8 → 21 MB jar in ~3 min. (`provision/buildtools.ts`.)

### Changed
- **`via` is now advisory, not a blanket skip.** A `via: true` target only honest-skips
  `VIA_BRIDGE_UNAVAILABLE` when its `mc` is *outside* the bot's native range (genuinely needs
  ViaProxy — a deferred follow-on); in-range versions (incl. legacy like 1.8.9) connect directly.
  An out-of-range target without `via` is skipped by capability negotiation (`NO_COMPATIBLE_DRIVER`).
- **Headless driver — improved handling of custom items** in selector resolution: richer
  display-name / NBT normalization (`packages/driver-headless/src/normalize.ts`) and container-GUI
  element mapping (`primitives/containerGui.ts`), with a new `Target` field + `PaperProvisioner`
  wiring and a CLI flag. Adds headless-driver test coverage. (`6305f72`)

### Fixed
- **Rendered client on a desktop OS without Xvfb.** `startDisplay` now falls back to the **native
  desktop display** when an `xvfb` display is requested but `Xvfb` cannot be spawned (Windows/macOS, or
  a Linux box without it) — previously the boot died with `spawn Xvfb ENOENT`. Selection still honors an
  explicit `xvfb` pref; this is a runtime safety net so a `display: xvfb` matrix row also runs on a real
  desktop. Surfaced by the first real rendered boot on Windows. (`driver-inprocess/launch/Display.ts`.)
- **Fabric/Quilt client missing Fabric API.** The in-process driver now resolves + stages **fabric-api**
  into the rendered Fabric client's `mods/` (newest build for the target MC, from `maven.fabricmc.net`).
  The `client-fabric` agent AND the SUT mods hard-depend on it, so the client previously refused to launch
  (`HARD_DEP_NO_CANDIDATE … fabric-api`). Surfaced by the first real rendered boot.
  (`driver-inprocess/launch/ClientProvisioner.ts`.)
- **Client-agent join→command race (THE rendered-GUI blocker).** `world.join` returned as soon as the
  connection was *initiated*, but `client.player` stays null for several render ticks after — so a command
  or chat issued immediately after join (the canonical `/or`) ran while `client.player` was null and was
  **silently dropped** by `runCommand`/`sendChat`, so the SUT screen never opened and `waitForScreen` timed
  out. `joinServer` now **waits (off the render thread) for the player to spawn** before returning, in all
  three client agents (`agents/client-{fabric,forge,neoforge}/.../mappings/Names.java`). This — not the
  foreground/focus — was why the rendered clientgui flow never reached the GUI; with it, the off-screen
  Fabric run drives `/or` → screen → click → **type** → create → load → assertChat end-to-end.
- **Per-step capability union now reflects the LIVE grant, not the static descriptor.** A driver
  connection contributes its **session's granted** caps to the per-step union (like agents already did),
  so a step requiring a capability the agent did not live-grant honestly **skips** instead of failing —
  e.g. `screenshot` on a rendered client whose agent computed caps at startup before the framebuffer
  existed. (`engine/SessionGroup.ts`; the documented CAPABILITIES.md §4 follow-up.)

## [1.0.0] — 2026-06-16

First usable product: a generalized, Appium-style automated testing framework for **Spigot/Paper
plugins**, authored once in semantic steps and run against a real Paper boot. Internal/private release
(not published). Build phases F0–F6; protocol/driver milestones M1–M3.

### Added
- **MCTP contract** (`@mc-test/protocol`, M1): JSON-RPC 2.0 over WebSocket with Appium-style capability
  negotiation — method catalog, capability keys, selector keys, error model, and golden conformance
  fixtures. TS types and JSON Schema kept in sync by a CI drift gate. Plus an authoring JSON Schema for
  `.mctest.yml` step files.
- **Runner** (`@mc-test/runner`, bin `mc-test`, M2/F5): capability-driven driver selection, the
  `SelectorWaits` retry/poll engine, YAML **and** fluent authoring (one internal model), JUnit XML +
  HTML reporting, the `(test × target)` skip matrix, and `mc-test run | list | doctor | init`.
- **Headless driver** (`@mc-test/driver-headless`, M2): Mineflayer-based path for server-driven GUIs
  (chest / anvil / sign menus), chat, and commands; hosts its own MCTP WebSocket server.
- **server-bukkit agent** + **agents/core** (M3/F1): authoritative world-truth, deterministic fixtures,
  and `truth.assertPluginState` — **green against real Paper server state** (not just chat), via the
  two-connection `SessionGroup` fan-out. Bukkit/Paper API only (no obfuscation mappings).
- **Gradle / IntelliJ front door** (`io.mctest.mc-test`, F6): `./gradlew mcTest` builds the SUT jar,
  boots an ephemeral Paper server, and runs the suite from the IDE. Committed Gradle 9.4.0 wrappers.
- **Provisioning** (F1/F2): hardened Paper provisioner (EULA / `server.properties` forcing, port
  leasing, ordered teardown, `keepOnFailure`, readiness probes); `sha256`-verified `path` / `url`
  sources.
- **CI + foundation** (F0): fast-lane CI (TS + JVM gates, conformance replays, schema-drift gate,
  mappings import-scan) + a nightly / dispatch real-boot E2E lane; MIT `LICENSE`.
- **Negative controls** ("the tester doesn't lie"): truth/UI divergence → red, capability miss →
  honest skip, enforced in the suites.

### Notes — deferred to v2
The in-process **rendered-client** driver and `client-*` agents (real mod Screens), the
`(loader × version)` matrix (Forge / NeoForge / Fabric), **genuine** ViaProxy bridging, **genuine**
Carpet fake players, the pixel/OCR driver backend, and the `maven` / `modrinth` / `github` source
resolvers are scaffolded but not built or run — they **honestly skip** today (never a false green).
