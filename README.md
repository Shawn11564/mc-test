# mc-test

**A WebDriver/Appium-style automated testing framework for Minecraft plugins and mods** — across many
Minecraft versions and loaders (Spigot/Paper/Folia; Fabric/Forge/NeoForge/Quilt; MC 1.8 → 1.21 and
beyond). Write a test **once** in semantic steps, run it across the whole matrix, and validate
pass/fail from **real runtime state** — not a mock.

```
join localhost → /or → click "Regions" → click "TestRegion"
  → assert chat contains "Region loaded"
  → assert region "TestRegion" exists
```

…runs unchanged on Paper 1.20.4 (headless bot), on a rendered Fabric/NeoForge client (in-process mod
agent), and everywhere in between.

## The narrow waist (the whole idea in 3 sentences)

mc-test is built as a **narrow waist (hourglass)**: a stable test-authoring layer on top (fluent API +
YAML step files), ONE stable wire contract in the middle — the **MC Test Protocol (MCTP)**, JSON-RPC
2.0 over WebSocket with Appium-style capability negotiation — and many **swappable drivers**
underneath. A test declares the *capabilities* it needs; the runner negotiates and picks the cheapest
driver that can satisfy them, or **skips with a clear reason**. All the intelligence (selectors,
retries, assertions, reporting) lives **outside** the game in version-independent TypeScript, so the
in-game agents stay tiny, dumb, and cheap to port to each `(loader × version)`.

## The drivers (selected per target by capabilities)

1. **Headless protocol bot** (`/packages/driver-headless`) — TypeScript on Mineflayer + minecraft-data
   + ViaVersion/ViaProxy. Fast, CI-friendly; chat/command + server-driven inventory GUIs. Cannot see
   client-rendered mod Screens.
2. **In-process client agent** (`/packages/driver-inprocess` + `/agents/client-*`) — a tiny Fabric/
   Forge/NeoForge mod inside the **real** client. The only way to test real mod client GUIs,
   screenshots, and rendering.
3. **Server-side agent** (`/agents/server-bukkit` + `/agents/server-fabric`) — native world-truth +
   plugin-state assertions, fixtures, fake players. Rides alongside driver 1 or 2.
4. **Pixel/OCR driver** (`/packages/driver-pixel`) — universal last resort; brittle (OCR/template over
   raw pixels). A **selectable stub** (M5): registered at the highest cost and chosen only when no
   structural driver fits.

## Quickstart

> Status: **M1–M5 landed.** The protocol (`@mc-test/protocol`), runner + headless driver, the
> `server-bukkit` truth agent, the `client-fabric` + in-process driver, and the **M5 fan-out**
> (`client-forge` / `client-neoforge` / `server-fabric` shims + the `pixel` last-resort driver) are in.
> The TypeScript runner/protocol/driver suites and the Java `core` tests are green; the rendered-client
> and loader-agent builds (Loom / ForgeGradle / NeoGradle + a display) are **acceptance-only**. See
> `docs/ROADMAP.md` for the build order and per-milestone status.

```bash
# install (npm workspaces monorepo)
npm install

# list what would run from the matrix
npx mc-test list

# run the canonical regions test against a local Paper target
npx mc-test run examples/regions/regions.mctest.yml --target paper-1.20.4

# environment doctor (checks Java, ports, downloads, EULA, display backend)
npx mc-test doctor
```

The environment matrix lives in `mc-test.yml` (see `mc-test.example.yml` for a fully worked example).
JUnit XML + a per-failure artifacts bundle land under `./mc-test-report/`.

## Documentation

Start with the design docs in [`/docs`](./docs):

- [`ROADMAP.md`](./docs/ROADMAP.md) — build order (M1→M5), acceptance criteria, testing strategy.
- [`ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — the narrow-waist model, the 4 drivers, diagrams.
- [`PROTOCOL.md`](./docs/PROTOCOL.md) — the MCTP wire spec (envelopes, methods, errors, events).
- [`CAPABILITIES.md`](./docs/CAPABILITIES.md) — capability registry + driver negotiation.
- [`SELECTORS.md`](./docs/SELECTORS.md) — the semantic selector grammar.
- [`DRIVERS.md`](./docs/DRIVERS.md) — the four drivers in detail.
- [`ENVIRONMENTS.md`](./docs/ENVIRONMENTS.md) — the `mc-test.yml` matrix + provisioning.

Contributors and agents: read [`CLAUDE.md`](./CLAUDE.md) first — it carries the prime directives, the
repo layout, and the rules for working here.

## License

TBD.
