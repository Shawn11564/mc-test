# Changelog

All notable changes to this project are recorded here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims to follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> mc-test is currently **internal/private** (decision **D1**, 2026-06-16): the `@mc-test/*` packages are
> not published to npm and the agent jars are not attached to GitHub Releases. Version tags are internal
> release markers. Revisit publishing for v2.

## [Unreleased]

### Changed
- **Headless driver — improved handling of custom items** in selector resolution: richer
  display-name / NBT normalization (`packages/driver-headless/src/normalize.ts`) and container-GUI
  element mapping (`primitives/containerGui.ts`), with a new `Target` field + `PaperProvisioner`
  wiring and a CLI flag. Adds headless-driver test coverage. (`6305f72`)

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
