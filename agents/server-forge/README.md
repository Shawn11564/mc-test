# mc-test-server-forge

The **server-side mc-test agent** for **Forge dedicated servers** (the Forge twin of `server-fabric` /
`server-bukkit`): a thin server mod that hosts an MCTP WebSocket server and answers the **world-truth /
fixtures / plugin-state** half of the protocol. PROTOCOL.md is the single source of truth for the wire;
this module only binds Forge **server** primitives behind the advertised handlers. All intelligence
(negotiation, error mapping, the dispatch loop) lives in the shared `io.mctest:mc-test-agent-core`.

`agent.kind = serverMod` (the Bukkit plugin advertises `serverPlugin`; this is its Forge server-mod
twin, DRIVERS.md §3).

> **This module is a thin shim.** It mirrors the **wiring** of `/agents/server-fabric`
> (`McTestServerMod`) but binds Mojmap-mapped Forge server APIs instead of Yarn-mapped Fabric ones. Per
> Prime Directive 2, fan-out (other MC versions) re-implements **only `mappings/Names.java`**; the core,
> the handler skeleton, and the pure-Java helpers are unchanged.
>
> **One deliberate difference from the fabric/bukkit twins: `fakePlayers` is DROPPED.** Forge has no
> Carpet fake-player backend, so this agent does **not** advertise `fakePlayers` and registers **no**
> `player.spawnFake` / `player.despawnFake`. A test that requires `fakePlayers` honestly **skips** on a
> Forge target rather than false-greening.

## ⚠️ Acceptance-only build (not built in this repo's CI)

ForgeGradle downloads Minecraft + the MCP/official mappings + the Forge userdev and needs the
**network** and a real **dedicated server runtime** to build and run. So this is a **standalone Gradle
build** (its own `settings.gradle.kts`, **not** part of `agents/settings.gradle.kts`), and it is
**not** compiled in this repo's CI — exactly like `agents/client-forge`, `agents/client-neoforge`, and
`agents/server-fabric`. The sources here are written to be correct against the contract but are
validated by inspection, not by a build in this environment.

The **CI-provable** half of the server agent — the loader-neutral wire logic and the pure-Java handler
skeleton — lives in `/agents/core` (the cross-driver `ConformanceTest`) and in `/agents/server-bukkit`,
from which this module is mirrored. The pure-Java pieces shared between the server agents (`Params`,
`StateQuery`, `FixtureLedger`, `AppliedFixture`) are copied byte-for-byte from `server-fabric` (only the
package declaration differs). What needs a real Forge server (live `ServerLevel`, game rules,
inventories) is acceptance-only and uses Mojmap/SRG mappings.

> **Mojmap spellings to verify on an acceptance build.** Forge 1.20.1 develops against Mojang (official)
> names and reobfuscates to SRG at build. `mappings/Names.java` carries `// TODO(acceptance)` markers on
> the method spellings that could not be confirmed without a real ForgeGradle build (e.g.
> `ServerLevel#getMinBuildHeight`/`getMaxBuildHeight`, `Level#hasChunk`, `Level#getDayTime` /
> `ServerLevel#setDayTime`, `ServerLevel#setWeatherParameters`, `GameRules#visitGameRuleTypes` /
> `Key#getId`, `Property#getName(T)`, `Inventory#add` / `Container#clearContent`,
> `PlayerList#getPlayerByName`/`getPlayer(UUID)`, `MinecraftServer#createCommandSourceStack` /
> `Commands#performPrefixedCommand`). Verify each in the mapping-contract test on a real build.

## Capabilities advertised

`agent.kind = serverMod`, with the `serverMod` bundle MINUS `fakePlayers` (PROTOCOL.md §6.1–§6.2; mirrors
`SERVER_FORGE_CAPABILITIES` in the runner's `cli.ts`):

| Capability | Methods | Detail |
|---|---|---|
| `worldTruth` | `truth.getWorldBlock`, `truth.getEntities` | `radiusLimit: 64`, `version: 1` |
| `pluginState` | `truth.assertPluginState` | — |
| `fixtures` | `fixture.set`, `fixture.reset` | — |
| `chat` | (advertised for co-selection; chat events come from the UI driver) | — |
| `testIdTags` | `testId` selector resolution carriers for SUTs we control | — |

It does **not** advertise `fakePlayers` (no Carpet on Forge), nor `clientScreens` / `containerGui` /
`screenshot` (a dedicated server has no client UI). Pair with `client-forge` for the rendered-GUI half
(the runner unions the co-selected agents' caps; missing caps **skip honestly**).

The universal `session.*` group and `world.join` / `world.leave` are handled by the core `Dispatch`;
`world.join` is a no-op that transitions the session to Connected (the agent is already in the server
process). The entrypoint registers **no** `session.*` or `world.*` methods itself — only the five above.

## The 5 handlers (all game access on the server thread)

Every handler bounces its game access onto the Minecraft **server thread** via `Names.call(body,
timeoutMs)` — the Forge analogue of the fabric agent's bounce, implemented with
`MinecraftServer.submit(...)` + a `CompletableFuture` (run inline when already on the server thread or
during shutdown so socket-close cleanups still run). A main-thread overrun maps to `-32003 TIMEOUT`.

- **`truth.getWorldBlock`** (`truth/WorldTruth`) — `ServerLevel#getBlockState(pos)` →
  `{ type, properties?, biome }` (`type` is the lowercase `minecraft:path` block id; `properties` read
  from the `BlockState`'s `Property` set). Out-of-range Y / unloaded chunk / unknown world →
  `-32004 WORLD_NOT_READY`.
- **`truth.getEntities`** (`truth/WorldTruth`) — `ServerLevel#getEntities` in a box, filtered to a
  sphere; maps to `{ id, uuid, type, name?, position, tags?, customNameRaw? }`. `radius` above the
  granted `worldTruth.radiusLimit` → `-32602 invalidParams`.
- **`truth.assertPluginState`** (`truth/PluginStateProbe`) — resolves the value via the F5 loader
  built-in (`mod.loaded`/`plugin.loaded` → `ModList.get().isLoaded(id)`) first, then the SUT's
  `McTestStateProvider` (discovered via `ServiceLoader`), evaluates the optional `expect` predicate with
  the core `Predicates`, and returns `{ query, value, matched, valueJson }`. With no provider, a
  non-built-in query is unknown → `-32006 ASSERT_FAILED` (a vanilla Forge server has no Bukkit-style
  config/perms fallback).
- **`fixture.set`** (`fixtures/FixtureManager`) — built-in recipes `gamerule`, `time`, `weather`,
  `inventory` (give/clear); any other fixture a registered `McTestFixtureProvider#supports` is delegated
  to that provider (e.g. `regions.createRegion`). Each apply records an undo in a per-session
  `FixtureLedger`. The `permissions` recipe is **unsupported** here (no vanilla Forge per-player
  permission API) — delegated to a provider when one claims it, otherwise `-32005 FIXTURE_FAILED`
  (honest, not a false green). Unknown/failed → `-32005 FIXTURE_FAILED`; bad args → `-32602`.
- **`fixture.reset`** (`fixtures/FixtureManager`) — with `fixtureId` reverts one handle, otherwise
  reverts all session fixtures (LIFO). `snapshot` restore is not supported by this build →
  `-32005 FIXTURE_FAILED`.

There is **no** `player.spawnFake` / `player.despawnFake` here (fakePlayers dropped on Forge).

Per-session resources (applied fixtures) are released automatically on `session.close` and on socket
close via the core `ResourceRegistry`.

## SUT integration — the SPIs via `ServiceLoader` (the Forge discovery mechanism)

A System Under Test exposes real state and custom fixtures by implementing the **pure-Java** SPIs from
the core (`McTestStateProvider`, `McTestFixtureProvider`). The Bukkit agent resolves them through the
Bukkit `ServicesManager`; **Forge has no such registry**, so this agent uses **`java.util.ServiceLoader`**
(exactly like `server-fabric`). A SUT mod ships a provider declaration:

```
# META-INF/services/io.mctest.agent.core.McTestStateProvider
com.example.regions.RegionsStateProvider

# META-INF/services/io.mctest.agent.core.McTestFixtureProvider
com.example.regions.RegionsFixtureProvider
```

`mappings/Names.java#lookupStateProvider()` / `lookupFixtureProvider()` call
`ServiceLoader.load(SPI.class, getClass().getClassLoader())` and return the first registered provider.
Because both the SUT mod and the shaded agent core load the **same** SPI class on the common mod
classloader, the lookup resolves. Without a provider, `truth.assertPluginState` honestly fails
(`ASSERT_FAILED`) for non-built-in queries and SUT-specific fixtures fall back to built-in recipes only.

## Server-lifecycle usage

The dedicated server is captured via Forge's **server-lifecycle events**
(`ServerStartingEvent` / `ServerStartedEvent` / `ServerStoppingEvent` on `MinecraftForge.EVENT_BUS`,
owned inside `mappings/Names.java`): the agent starts its MCTP server on `ServerStartedEvent` (so the
server thread exists for the `Names.call` bounce) and stops it on `ServerStoppingEvent`, capturing the
`MinecraftServer` from `event.getServer()`. World/entity truth uses the server-thread `ServerLevel`
directly, matching the fabric/bukkit agents' runtime-state reads.

## The mappings quarantine (Prime Directive 2)

`mappings/Names.java` is the **ONLY** file allowed to import `net.minecraft.*` / Mojmap / Forge symbols
(`MinecraftServer`, `ServerLevel`, `BlockState`, `Property`, `GameRules`, `ResourceLocation`,
`BuiltInRegistries`, the `ServerStarted/StoppingEvent`s, …). `McTestServerMod` imports **only** the
shared core, the serverforge handler classes (pure Java over the `Names` façade), and the Forge `@Mod`
annotation. The handler classes (`WorldTruth`/`PluginStateProbe`/`FixtureManager`) import only
`io.mctest.agent.core.*` + the `Names` façade and its plain DTOs — never a Minecraft type.

A CI **import-scan** greps this module's sources and **fails** if any `net.minecraft.*` / Mojmap import
appears outside `mappings/Names.java`. This keeps the per-version obfuscation tax confined to one file.
The base name is `agent-server-forge` (resolver/install form `agent-server-forge-<mc>.jar`, per the
`agent-<variant>-<mc>.jar` convention).

## Build (acceptance-only — needs ForgeGradle + network)

The core must be published to mavenLocal first:

```
# in /agents
gradle :core:build :core:publishToMavenLocal

# in /agents/server-forge (standalone build; NEEDS NETWORK + ForgeGradle — not run in this repo's CI)
gradle build
```

The reobfuscated **shaded** mod jar `build/libs/agent-server-forge.jar` shades the core +
Java-WebSocket **+ Gson** via the Shadow plugin (Forge has no Loom `include` jar-in-jar). Note the
**Gson** shading (like `server-fabric`, unlike `server-bukkit`): Paper ships Gson at runtime, but a
vanilla Forge **dedicated server** does not reliably expose Gson to our classes, so this build **shades
Gson in** to guarantee the envelope/JSON code resolves at runtime. `slf4j` is **excluded** from the shade
(Forge already provides an `org.slf4j` module under the JPMS module system; bundling it would split the
package at boot). The shaded jar is then **reobfuscated** (official → SRG) so `mappings/Names.java`'s
`net.minecraft.*` calls resolve on a production (SRG-mapped) server.

The jar is dropped into the server's `mods/` alongside the SUT mod. On start the agent logs
**`MCTP listening on :PORT`** — the line the runner scrapes to learn the port. The MCTP port is read from
env **`MCTEST_AGENT_PORT`** (default `25575`, matching the fabric/bukkit agents), bound on `127.0.0.1`.
The runner's `KNOWN_AGENTS` already references
`agents/server-forge/build/libs/agent-server-forge.jar` and **honest-skips** the server-truth steps when
that jar is absent (the cost-1 `server` driver needs an agent).
