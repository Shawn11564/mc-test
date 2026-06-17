# OpenRegions — Forge SUT (`mod-forge`)

The canonical **regions** example built as a **Forge** client mod (MC **1.20.1**, Forge **47.2.0**,
official mappings, Java 17) — the Forge sibling of [`mod-fabric`](../mod-fabric) and
[`mod-neoforge`](../mod-neoforge). It is the same `OpenRegions` behavior as the
[plugin](../plugin), expressed as a real client `Screen` that only the in-process (rendered) driver can
see, driven by the **`client-forge`** agent.

## What it does

`/or` (a **client** command, registered via `RegisterClientCommandsEvent`, so it is intercepted before
the Paper server's own `/or`) opens the root Screen with a **Regions** button → a list Screen:

- one entry per region (seeded `TestRegion`, `Spawn`, `Market`) — click to **load** (`Region loaded: <name>`),
- a **name field** + **Create** button — type a name to **create** (`Region created: <name>`),
- a **Delete** button — removes the active region (`Region deleted: <name>`).

Chat lines round-trip through the server so the client agent observes them. This SUT has **zero mc-test
coupling** — it's a plain Forge mod with no dependency on the agent core — so the agent drives it purely
through the real UI: the cross-loader test selects buttons by **label** and the text field by its
**role** (`input`). (The Fabric SUT additionally exposes `TestIdHolder` testIds to demonstrate robust
selection for cooperating SUTs; Forge/NeoForge omit it to show black-box driving and to avoid any
cross-module class coupling on the loader's module system.)

The server-truth half (`assertPluginState regions.exists`) is seeded with a `fixture` step and read by the
Paper-side `server-bukkit` agent — a client mod cannot author server state. See
[`../README.md`](../README.md) for the action→truth vs fixture→truth distinction.

## Build

```bash
gradle :core:publishToMavenLocal      # in /agents — publishes the TestIdHolder marker to mavenLocal
./gradlew build                       # here — ForgeGradle decompiles MC 1.20.1 (slow first run)
# → build/libs/openregions-forge.jar  (injected as regions.jar by the forge-1.20.1-client matrix row)
```

> **Acceptance-only build.** ForgeGradle needs the Minecraft toolchain + network, so this is a standalone
> Gradle build, not part of the offline npm/agents CI. The rendered Forge boot is opt-in
> (`MC_TEST_RENDERED_LOADERS=forge`); otherwise the `forge-1.20.1-client` target honestly skips.
