# OpenRegions — NeoForge SUT (`mod-neoforge`)

The canonical **regions** example built as a **NeoForge** client mod (MC **1.21.1**, NeoForge
**21.1.66**, Mojmap, Java 21) — the NeoForge sibling of [`mod-fabric`](../mod-fabric) and
[`mod-forge`](../mod-forge). Same `OpenRegions` behavior as the [plugin](../plugin), expressed as a real
client `Screen` that only the in-process (rendered) driver can see, driven by the **`client-neoforge`**
agent.

## What it does

`/or` (a **client** command, registered via `RegisterClientCommandsEvent` on the NeoForge game bus, so
it is intercepted before the Paper server's own `/or`) opens the root Screen with a **Regions** button →
a list Screen:

- one entry per region (seeded `TestRegion`, `Spawn`, `Market`) — click to **load** (`Region loaded: <name>`),
- a **name field** + **Create** button — type a name to **create** (`Region created: <name>`),
- a **Delete** button — removes the active region (`Region deleted: <name>`).

Chat lines round-trip through the server so the client agent observes them. This SUT has **zero mc-test
coupling** — a plain NeoForge mod — so the agent drives it purely through the real UI: the cross-loader
test selects buttons by **label** and the text field by its **role** (`input`).

The server-truth half (`assertPluginState regions.exists`) is seeded with a `fixture` step and read by the
Paper-side `server-bukkit` agent — a client mod cannot author server state. See
[`../README.md`](../README.md) for the action→truth vs fixture→truth distinction.

## Build

```bash
./gradlew build                          # NeoGradle resolves MC 1.21.1 + NeoForge (slow first run)
# → build/libs/openregions-neoforge.jar  (injected as regions.jar by the neoforge-1.21-client row)
```

> **Acceptance-only build.** NeoGradle needs the Minecraft toolchain + network, so this is a standalone
> Gradle build, not part of the offline npm/agents CI. The rendered NeoForge boot is opt-in
> (`MC_TEST_RENDERED_LOADERS=neoforge`); otherwise the `neoforge-1.21-client` target honestly skips.
> NeoForge runs Mojmap names at runtime, so there is no reobfuscation step.
