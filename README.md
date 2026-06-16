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

> Status: **v1.0 Paper/plugin product is real** (merged to `main`). A real Paper boot drives
> the regions GUI and asserts server-side state (`assertPluginState`); runnable via the CLI **and**
> `gradle mcTest`, with CI gates, an HTML + JUnit report, and user docs. Rendered-client **mod** GUIs and
> the multi-loader matrix are **v2** — those targets honestly *skip*. See
> [`docs/V1_PLAN.md`](./docs/V1_PLAN.md) for status + what remains, and
> [`docs/GETTING_STARTED.md`](./docs/GETTING_STARTED.md) to run it.

```bash
# build the framework (Node 18+; builds @mc-test/* in dependency order)
npm install && npm run build

# build the example SUT + the server-truth agent (one-time, until artifacts are published)
gradle -p agents :core:publishToMavenLocal :server-bukkit:jar
mvn -f examples/regions/plugin/pom.xml package

# run the canonical regions test on a real Paper server
npx mc-test run examples/regions/regions.mctest.yml --target paper-1.20.4

# other commands
npx mc-test doctor    # check Java, ports, downloads, matrix
npx mc-test init      # scaffold mc-test.yml + a sample test in your own plugin project
```

> **New here? Follow [`docs/GETTING_STARTED.md`](./docs/GETTING_STARTED.md)** for the full, verified walkthrough.

The environment matrix lives in `mc-test.yml`. An HTML report + JUnit XML (and a per-failure
artifacts bundle) land under `./mc-test-report/`. JVM/IntelliJ users can instead run
`./gradlew mcTest` — see [`gradle-plugin/README.md`](./gradle-plugin/README.md).

## Documentation

**User docs (start here):**

- [`GETTING_STARTED.md`](./docs/GETTING_STARTED.md) — install → run the regions test → write your own.
- [`AUTHORING.md`](./docs/AUTHORING.md) — step verbs, selectors, capabilities, fluent ↔ YAML.

**Design docs** in [`/docs`](./docs):

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

[MIT](./LICENSE). (Public-vs-internal *distribution* is still TBD — see `docs/V1_PLAN.md`; the source
license itself is MIT.)
