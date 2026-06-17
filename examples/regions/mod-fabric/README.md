# OpenRegions — Fabric SUT (`mod-fabric`)

The canonical **regions** example built as a **Fabric** client mod (MC **1.21.1**, Yarn, Java 21) — the
Fabric sibling of [`mod-forge`](../mod-forge) and [`mod-neoforge`](../mod-neoforge). Same `OpenRegions`
behavior as the [plugin](../plugin), expressed as a real client `Screen` that only the in-process
(rendered) driver can see — the deliberate **negative control** proving the `clientScreens` capability
is genuinely needed (a headless bot provably cannot inspect or click these widgets).

## What it does

`/or` (a **CLIENT** command — no server round-trip) opens the root Screen ("OpenRegions") with a
**Regions** button → a list Screen:

- one entry per region (seeded `TestRegion`, `Spawn`, `Market`) — click to **load** (`Region loaded: <name>`),
- a **name field** + **Create** button — type a name to **create** (`Region created: <name>`),
- a **Delete** button — removes the active region (`Region deleted: <name>`).

Chat lines round-trip through the server (`networkHandler.sendChatMessage`) so the client agent's chat
observer receives them.

## Selection: label + role (with testId as a Fabric bonus)

The cross-loader `regions.clientgui.mctest.yml` test selects buttons by their visible **label** and the
text field by its **role** (`input`), so the single test file runs unchanged across Fabric/Forge/NeoForge.
This Fabric SUT *additionally* exposes `io.mctest.agent.core.client.TestIdHolder` testIds
(`regions:root:regions`, `regions:entry:<name>`, `regions:action:create|delete`, `regions:input:name`) to
demonstrate robust selection for a SUT you control — the same ids the plugin stamps onto its items. (The
Forge/NeoForge SUTs omit `TestIdHolder` to stay fully decoupled from mc-test; see their READMEs.)

## The two halves of the assertion

| Half | Owner |
|---|---|
| Chat: `Region loaded: TestRegion` | this mod (round-tripped through the server) |
| Server-truth: region `TestRegion` exists | the Paper-side `server-bukkit` agent reading the plugin's `RegionStore` |

A client mod **cannot author authoritative server state**, so the rendered matrix rows co-load the
server-side regions [plugin](../plugin) + the `server-bukkit` truth agent. `TestRegion` is seeded by the
plugin, so `assertPluginState regions.exists` is honestly green and **independent** of the GUI — the
truth/UI-divergence control (a never-created region → RED) is what proves the truth half isn't
rubber-stamping chat. With no server agent the step honestly skips (`unmet:[pluginState]`); the chat half
still proves the GUI flow. See [`../README.md`](../README.md) for the action→truth vs fixture→truth model.

## Build

```bash
gradle :core:publishToMavenLocal      # in /agents — publishes the TestIdHolder marker to mavenLocal
./gradlew build                       # here (Loom; resolves Minecraft/Yarn + the marker)
# → build/libs/openregions-fabric.jar (injected as regions.jar by the fabric-1.21-client matrix row)
```

`TestIdHolder` is `compileOnly`: at runtime the client-fabric agent's bundled core owns
`io.mctest.agent.core.client.*`, so this mod does not ship its own copy.

> **Acceptance-only build.** Fabric Loom needs the Minecraft toolchain + network, so this is a standalone
> Gradle build, not part of the offline npm/agents CI. The rendered Fabric boot runs in the
> `fabric-rendered-client` CI lane (Xvfb + Mesa) or on a desktop runner.
