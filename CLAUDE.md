# mc-test — Project Instructions (read me FIRST)

> Every agent working in this repo reads this file before doing anything. Keep it TIGHT and
> skimmable; link out to `/docs` for detail instead of duplicating it here. If you change a
> name/key/method/path, update `/docs` in the same change (see Prime Directives).

## Overview

`mc-test` is a generalized, WebDriver/Appium-style automated testing framework for Minecraft
**plugins and mods**, across many Minecraft versions and loaders (Spigot/Paper/Folia;
Fabric/Forge/NeoForge/Quilt; MC 1.8 → 1.21 and beyond). You author a test **once** in semantic steps
(`join localhost → /or → click "Regions" → click "TestRegion" → assert chat "Region loaded" AND
region "TestRegion" exists`) and run it **across the whole matrix**, validating pass/fail from **real
runtime state**. The architecture is a **narrow waist**: a stable test-authoring layer on top, ONE
stable wire contract in the middle — the **MC Test Protocol (MCTP)**, JSON-RPC 2.0 over WebSocket
with Appium-style capability negotiation — and many **swappable drivers** underneath, selected per
target by capabilities. Runner language (TypeScript) and in-game language (Java) are decoupled by the
protocol.

## Prime Directives (non-negotiable)

1. **Protocol-first.** MCTP is the keystone; every backend is "just another driver." Never introduce a
   runner→driver coupling that bypasses MCTP. Transport (WebSocket + JSON-RPC 2.0) is NOT swappable —
   it *is* the contract. The runner is the JSON-RPC **client**; each driver/agent is the **server**.
2. **Tiny, dumb, version-specific agents.** In-game agents expose **primitives only** —
   `screen.listElements`, `screen.clickElement`, `screen.get`, `screen.typeText`, `screen.pressKey`,
   `screen.screenshot`, `truth.getWorldBlock`, `truth.getEntities`, `fixture.set`, `player.spawnFake`,
   `truth.assertPluginState`. **All** intelligence (selector
   resolution, retries/waits, assertions, orchestration, reporting) lives **outside** the game in
   version-independent TypeScript. Generate per-loader agents from ONE shared core (`/agents/core`);
   only the thin shim recompiles per `(loader × version)`. Obfuscation mappings (Yarn/MCP-SRG/Mojmap)
   are the per-version tax — **quarantine them in one file** (`agents/client-*/mappings/Names.java`).
3. **Semantic selectors, never coordinates.** A test says `click({ label: "Regions" })`; each driver
   resolves it (bot → inventory slot display-name; client mod → `ClickableWidget` message; pixel →
   OCR/template). Slot indices and pixel coordinates **never** appear in a test. Supported selector
   keys are ANDed: `label`, `text`, `textContains`, `loreContains`, `itemType`, `role`, `index`,
   `nth`, `within`, `testId`. SUTs we control may emit invisible `testId` tags (NBT `mctp:testId` /
   data component `mc-test:test_id`) for robust selection.
4. **Capability negotiation.** Drivers advertise capabilities; tests declare required capabilities; the
   runner picks the cheapest compatible driver and **skips with a clear, machine-readable reason**
   (`NO_COMPATIBLE_DRIVER`, carrying `unmet[]`) when none fits. **Honest skips beat false greens** — a
   test that cannot run on the selected driver is reported `skipped`, never silently passed.
5. **Keep docs in sync.** `/docs` is the source of truth for every name/key/method/path. If your change
   touches a wire name, capability key, selector key, error code, step verb, or `mc-test.yml` field,
   update the relevant doc in the **same** change. Do not invent names — reuse the canonical ones.

## Canonical monorepo layout

```
/docs                         design docs (the contract set; read these first)
/packages/protocol            @mc-test/protocol — TS types + JSON Schema for MCTP + capability defs (THE shared contract; source of truth, generates .d.ts)
/packages/runner              @mc-test/runner (bin: mc-test) — CLI, orchestrator, MCTP client, YAML loader, JUnit reporter, fluent API
/packages/driver-headless     @mc-test/driver-headless — Mineflayer + minecraft-data + ViaVersion/ViaProxy; hosts an MCTP WS server
/packages/driver-inprocess    @mc-test/driver-inprocess — runner-side adapter that talks to the in-game client agent (launches/babysits a rendered client)
/packages/driver-pixel        @mc-test/driver-pixel — pixel/OCR universal last-resort driver (M5 selectable stub; cost 4; OCR/template backend unimplemented)
/agents/core                  Java shared agent core (MctpServer + Dispatch + PrimitiveHandler + SelectorMatch + ElementModel + Errors + Capabilities)
/agents/client-fabric         thin Fabric client mod (Yarn-mapped)        — real client Screens/widgets
/agents/client-forge          thin Forge client mod (MCP-SRG-mapped)
/agents/client-neoforge       thin NeoForge client mod (Mojmap-mapped)
/agents/server-bukkit         Bukkit/Paper plugin agent — world-truth + fixtures + plugin-state (stable Bukkit API; no mappings)
/agents/server-fabric         server-mod truth agent (Fabric/NeoForge server)
/examples/regions             canonical sample test + "regions" SUT in all forms (plugin + fabric/forge/neoforge client mods)
/tests                        suites authored against the framework
mc-test.yml                   the environment matrix (per-target loader/mc/driver/world/plugins/mods)
```

## Where to look (`/docs` index — read the one that matches your task)

| Doc | Read it when you are… | Owns (authoritative for) |
|-----|-----------------------|--------------------------|
| `docs/ROADMAP.md` | building **anything**; planning a milestone | **Build order (M1→M5)**, per-milestone scope + acceptance criteria, the testing-the-tester strategy, the hard-parts register. Wire names are defined canonically in `docs/PROTOCOL.md`; `mc-test.yml` fields in `docs/ENVIRONMENTS.md`. |
| `docs/ARCHITECTURE.md` | onboarding; need the big picture | Narrow-waist model, 4 drivers, component + sequence diagrams, tech defaults + swap-path, monorepo layout. |
| `docs/PROTOCOL.md` | implementing MCTP envelopes/methods/errors | **THE single source of truth for the wire vocabulary**: envelope, session state machine, method catalog, params/results, error model, events, capability keys, selector keys, testId carriers, versioning. Other docs defer here for spellings. |
| `docs/CAPABILITIES.md` | adding/checking a capability; driver selection | Capability registry, driver cost order, negotiation/skip outcome shapes, JUnit mapping. |
| `docs/SELECTORS.md` | resolving elements; normalization; testId | Selector grammar, normalization pipeline, fuzzy matching, testId carriers, resolver contract. |
| `docs/DRIVERS.md` | building/choosing a driver | The 4 drivers, their capabilities, element/screen field shapes, bridge interfaces, build-artifact naming. |
| `docs/ENVIRONMENTS.md` | editing `mc-test.yml`; provisioning | `mc-test.yml` schema, source resolvers (Paper/Mojang/Maven/…), worlds, matrix, provisioning policy, forced server.properties. |

> ✅ **Naming resolved (ratified 2026-06-15).** The MCTP wire vocabulary is **namespaced `noun.verb`
> methods with `lowerCamelCase` fields** (e.g. `session.create`, `screen.clickElement`,
> `truth.assertPluginState`), and **`docs/PROTOCOL.md` is the single source of truth** for every method,
> capability key, selector key, error code, and testId carrier. Every other doc defers to it. If you
> change a wire name, change `docs/PROTOCOL.md` first, then update each dependent doc in the same
> change. Never introduce a synonym.

## Coding / build / test conventions

**Monorepo + TypeScript (runner side).**
- npm **workspaces** monorepo. Packages live under `packages/*`; each has its own `package.json`. Scope
  is `@mc-test/<pkg>`. The runner publishes a `bin` named **`mc-test`** (`mc-test run|list|doctor`).
- TypeScript **strict** (`tsc --strict`). `@mc-test/protocol` is **pure data + functions** — NO
  dependency on any game, Mineflayer, or the JVM. Drivers/runner depend on `@mc-test/protocol`, never
  the reverse.
- Naming on the wire: methods and JSON fields per `docs/ROADMAP.md` §2.3–2.5 (namespaced `noun.verb`
  methods; `lowerCamelCase` fields). Minecraft identifiers keep `namespace:path`.
- JSON Schema and TS types **must stay in sync** — a generator/round-trip test gates CI (the contract
  can't rot silently). Every MCTP method ships a TS param type, a TS result type, and a schema pair
  under `packages/protocol/schema/methods/`.
- Tests: prefer fast peers — a **mock agent** (`packages/runner/test/mockAgent.ts`) for runner unit
  tests, the **golden conformance fixtures** (`packages/protocol/fixtures/conformance/`) replayed by
  every driver. `/examples/regions` is the end-to-end system test.

**JVM agents (Java; Kotlin allowed).**
- Gradle (`build.gradle.kts`). `/agents/core` is shared and loader-neutral; each loader agent is a thin
  shim that depends on core and re-implements only its entrypoint + `mappings/Names.java`.
- A CI import-scan **fails** if obfuscation-mapped names leak outside `mappings/Names.java`. The Bukkit
  agent must reference the **Bukkit/Paper API only** (no NMS/Mojang-mapped symbols) so it needs no
  per-version remap.
- Build-artifact naming: `agent-<variant>-<mc>.jar` (e.g. `agent-server-bukkit-1.21.4.jar`,
  `client-fabric-<ver>.jar`).

**Provisioning / running (matrix).**
- `online-mode=false` (no Microsoft auth), loopback bind only, **pristine world snapshot per test**
  (isolation + parallel ports). Rendered clients run under Xvfb (Linux CI) or a desktop runner. The
  runner forces determinism server.properties (`doDaylightCycle=false`, `doWeatherCycle=false`,
  `randomTickSpeed=0`). EULA must be explicitly accepted to boot.
- Reporting: **JUnit XML** (one `<testsuite>` per target, one `<testcase>` per test; skips → `<skipped>`
  with a reason string) + a per-failure artifacts bundle (server/client logs, screenshots, optional
  video) under the configured artifacts dir.

**Leverage (do NOT rebuild these):** Appium/WebDriver (north-star protocol + capabilities + driver
model); Mineflayer + minecraft-data + ViaVersion (version-spanning headless driver); packetevents
(portable server packet lib); Fabric/NeoForge GameTest (world-behavior assertions); MockBukkit (pure
unit tests, no MCTP path); Carpet fake players (server-side automation).

## The canonical "regions" example (use throughout)

A `regions` plugin/mod (id **`OpenRegions`**) where `/or` opens a GUI with a **"Regions"** button
leading to entries like **"TestRegion"**. The canonical test (`regions-open-testregion`):

```
join localhost → /or → click "Regions" → click "TestRegion"
  → assert chat contains "Region loaded"
  → assert (server agent) region "TestRegion" exists   // pluginState query regions.exists {name:"TestRegion"} expect true
```

Canonical files: `examples/regions/regions.mctest.yml` (YAML step file) and
`examples/regions/regions.fluent.test.ts` (same test, fluent API). Usernames: `Tester`, `Bot2`. Until
the server agent lands (M3), the `assertPluginState` step **honestly skips** with
`unmet:["pluginState"]`.

## Rules for agents working in this repo (checklist)

- [ ] **Read the design docs first.** Start with `docs/ROADMAP.md` for build order + acceptance
      criteria, then the doc that owns the area you're touching (see the index above).
- [ ] **Match the canonical names/paths exactly.** Methods, capability keys, selector keys, error codes,
      step verbs, `mc-test.yml` fields, package names, and file paths must come from `/docs`
      (ROADMAP-authoritative). Never invent a synonym.
- [ ] **Stay in scope.** Build only what the current milestone defines. M1 = `/packages/protocol`
      (no game). M2 = `/packages/runner` + `/packages/driver-headless` runnable vs `/examples/regions`.
      Don't pull future-milestone agents/drivers forward.
- [ ] **Protocol-first.** Anything crossing the waist goes over MCTP. No bypass paths, no
      runner-special-casing of "headless vs agent" — same `MctpClient`, same envelopes.
- [ ] **Keep agents dumb.** No selectors/assertions/retries inside an agent. Push it to the runner.
- [ ] **Semantic selectors only.** No slot indices / pixel coords in tests.
- [ ] **Honest skips.** Capability misses → `skipped` with a reason, never a pass.
- [ ] **Update `/docs` with any contract change**, and reconcile cross-doc naming toward ROADMAP.
- [ ] **Adversarially verify before claiming done.** Run the acceptance criteria for your milestone.
      For M2 that means: actually boot the target and produce a REAL pass/fail JUnit result; add the
      negative controls (mutation → red, capability → skip) where the milestone calls for them.
- [ ] **Conformance is the bar.** A driver isn't "done" until it's green against the M1 conformance
      fixtures for every method it advertises.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
