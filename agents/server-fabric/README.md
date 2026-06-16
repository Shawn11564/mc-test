# mc-test-server-fabric

The **server-side mc-test agent** for Fabric/NeoForge **dedicated servers** (the server-mod variant of
`server-bukkit`): a thin server mod that hosts an MCTP WebSocket server and answers the **world-truth /
fixtures / fake-player / plugin-state** half of the protocol. PROTOCOL.md is the single source of truth
for the wire; this module only binds Fabric **server** primitives behind the advertised handlers. All
intelligence (negotiation, error mapping, the dispatch loop) lives in the shared
`io.mctest:mc-test-agent-core`.

`agent.kind = serverMod` (the Bukkit plugin advertises `serverPlugin`; this is its server-mod twin,
DRIVERS.md §3).

> **This module is a thin shim.** It mirrors the **wiring** of `/agents/server-bukkit`
> (`McTestAgentPlugin`) — the *same six advertised capabilities* and the *same seven handler
> registrations* — but binds Fabric server APIs instead of the Bukkit API. Per Prime Directive 2, M5
> fan-out (NeoForge server / other MC versions) re-implements **only `mappings/Names.java`**; the core,
> the handler skeleton, and the pure-Java helpers are unchanged.

## ⚠️ Acceptance-only build (not built in this repo's CI)

Fabric Loom downloads Minecraft + Yarn mappings and needs the **network** and a real **dedicated server
runtime** to build and run. So this is a **standalone Gradle build** (its own `settings.gradle.kts`,
**not** part of `agents/settings.gradle.kts`), and it is **not** compiled in this repo's CI —
`gradle :core:build :server-bukkit:build` stays fast and offline. The sources here are written to be
correct against the contract but are validated by inspection, not by a build in this environment
(exactly like `agents/client-fabric` and `examples/regions/mod`).

The **CI-provable** half of the server agent — the loader-neutral wire logic and the pure-Java handler
skeleton — lives in `/agents/core` (the cross-driver `ConformanceTest`) and in `/agents/server-bukkit`,
from which this module is mirrored verbatim. The pure-Java pieces shared between the two server agents
(`Params`, `StateQuery`, `FixtureLedger`, `AppliedFixture`) are copied byte-for-byte (only the package
declaration differs). What needs a real Fabric server (live `ServerWorld`, Carpet `/player`, game rules)
is acceptance-only.

## Capabilities advertised

`agent.kind = serverMod`, with exactly the `serverPlugin`/`serverMod` bundle (PROTOCOL.md §6.1–§6.2):

| Capability | Methods | Detail |
|---|---|---|
| `worldTruth` | `truth.getWorldBlock`, `truth.getEntities` | `radiusLimit: 64`, `version: 1` |
| `pluginState` | `truth.assertPluginState` | — |
| `fixtures` | `fixture.set`, `fixture.reset` | — |
| `fakePlayers` | `player.spawnFake`, `player.despawnFake` | `backend: "carpet"` |
| `chat` | (advertised for co-selection; chat events come from the UI driver) | — |
| `testIdTags` | `testId` selector resolution carriers for SUTs we control | — |

It does **not** advertise `clientScreens` / `containerGui` / `screenshot` — a dedicated server has no
client UI. Pair with `client-fabric` for the rendered-GUI half (the runner unions the co-selected
agents' caps; missing caps **skip honestly**).

The universal `session.*` group and `world.join` / `world.leave` are handled by the core `Dispatch`;
`world.join` is a no-op that transitions the session to Connected (the agent is already in the server
process). The entrypoint registers **no** `session.*` or `world.*` methods itself — only the seven
above.

## The 7 handlers (all game access on the server thread)

Every handler bounces its game access onto the Minecraft **server thread** via `Names.call(body,
timeoutMs)` — the Fabric analogue of the Bukkit agent's `MainThread.call`, implemented with
`MinecraftServer.submit(...)` + a `CompletableFuture` (run inline when already on the server thread or
during shutdown so socket-close cleanups still run). A main-thread overrun maps to `-32003 TIMEOUT`.

- **`truth.getWorldBlock`** (`truth/WorldTruth`) — `ServerWorld#getBlockState(pos)` →
  `{ type, properties?, biome }` (`type` is the lowercase `minecraft:path` block id; `properties` read
  from the `BlockState`'s `Property` set). Out-of-range Y / unloaded chunk / unknown world →
  `-32004 WORLD_NOT_READY`.
- **`truth.getEntities`** (`truth/WorldTruth`) — `ServerWorld#getOtherEntities` in a box, filtered to a
  sphere; maps to `{ id, uuid, type, name?, position, tags?, customNameRaw? }`. `radius` above the
  granted `worldTruth.radiusLimit` → `-32602 invalidParams`.
- **`truth.assertPluginState`** (`truth/PluginStateProbe`) — resolves the value via the SUT's
  `McTestStateProvider` (discovered via `ServiceLoader`, see below), evaluates the optional `expect`
  predicate with the core `Predicates`, and returns `{ query, value, matched, valueJson }`. With no
  provider, any query is unknown → `-32006 ASSERT_FAILED` (a vanilla Fabric server has no Bukkit-style
  config/perms fallback).
- **`fixture.set`** (`fixtures/FixtureManager`) — built-in recipes `gamerule`, `time`, `weather`,
  `inventory` (give/clear); any other fixture a registered `McTestFixtureProvider#supports` is delegated
  to that provider (e.g. `regions.createRegion`). Each apply records an undo in a per-session
  `FixtureLedger`. The `permissions` recipe is **unsupported** here (no vanilla Fabric per-player
  permission API) — delegated to a provider when one claims it, otherwise `-32005 FIXTURE_FAILED`
  (honest, not a false green). Unknown/failed → `-32005 FIXTURE_FAILED`; bad args → `-32602`.
- **`fixture.reset`** (`fixtures/FixtureManager`) — with `fixtureId` reverts one handle, otherwise
  reverts all session fixtures (LIFO). `snapshot` restore is not supported by this build →
  `-32005 FIXTURE_FAILED`.
- **`player.spawnFake`** / **`player.despawnFake`** (`players/FakePlayerManager`) — Carpet console
  command backend (`/player <name> spawn at <x> <y> <z>`, `/player <name> kill`), dispatched through
  `MinecraftServer#getCommandManager().executeWithPrefix(source, …)` at permission level 4; fakes are
  tracked per session and despawned on `session.close`.

Per-session resources (applied fixtures, spawned fakes) are released automatically on `session.close`
and on socket close via the core `ResourceRegistry`.

## SUT integration — the SPIs via `ServiceLoader` (the Fabric discovery mechanism)

A System Under Test exposes real state and custom fixtures by implementing the **pure-Java** SPIs from
the core (`McTestStateProvider`, `McTestFixtureProvider`). The Bukkit agent resolves them through the
Bukkit `ServicesManager`; **Fabric has no such registry**, so this agent uses
**`java.util.ServiceLoader`** instead. A SUT mod ships a provider declaration:

```
# META-INF/services/io.mctest.agent.core.McTestStateProvider
com.example.regions.RegionsStateProvider

# META-INF/services/io.mctest.agent.core.McTestFixtureProvider
com.example.regions.RegionsFixtureProvider
```

`mappings/Names.java#lookupStateProvider()` / `lookupFixtureProvider()` call
`ServiceLoader.load(SPI.class, getClass().getClassLoader())` and return the first registered provider.
Because both the SUT mod and the shaded agent core load the **same** `McTestStateProvider` /
`McTestFixtureProvider` class on Fabric's common mod classloader, the lookup resolves — the Fabric
equivalent of the Bukkit `ServicesManager` path. Without a provider, `truth.assertPluginState` honestly
fails (`ASSERT_FAILED`) and SUT-specific fixtures fall back to built-in recipes only.

## GameTest / server-hook usage

The dedicated server is captured via Fabric's **server-lifecycle hooks**
(`ServerLifecycleEvents.SERVER_STARTING/STARTED/STOPPING`, owned inside `mappings/Names.java`): the agent
starts its MCTP server on `SERVER_STARTED` (so the server thread exists for the `Names.call` bounce) and
stops it on `SERVER_STOPPING`. These hooks (plus the Fabric/NeoForge **GameTest** framework for
world-behavior assertions, per the leverage list) are the server-mod analogue of the Bukkit scheduler +
`ServicesManager` the plugin relies on. World/entity truth uses the server-thread `ServerWorld`
directly rather than a GameTest harness, matching the Bukkit agent's runtime-state reads.

## The mappings quarantine (Prime Directive 2)

`mappings/Names.java` is the **ONLY** file allowed to import `net.minecraft.*` / Yarn-mapped symbols
(`MinecraftServer`, `ServerWorld`, `BlockState`, `Property`, `GameRules`, `ServerCommandSource`,
`Registries`, `ServerLifecycleEvents`, …). `McTestServerMod` imports **only** the shared core, the
serverfabric handler classes (pure Java over the `Names` façade), and the Fabric loader entrypoint API
(`net.fabricmc.api.DedicatedServerModInitializer`). The handler classes
(`WorldTruth`/`PluginStateProbe`/`FixtureManager`/`FakePlayerManager`) import only
`io.mctest.agent.core.*` + the `Names` façade and its plain DTOs — never a Minecraft type.

A CI **import-scan** greps this module's sources and **fails** if any `net.minecraft.*` / Yarn import
appears outside `mappings/Names.java`. This keeps the per-version obfuscation tax confined to one file so
M5 can fan out by swapping only that file (and the build's mapping coordinates). The base name is
`agent-server-fabric` (resolver/install form `agent-server-fabric-<mc>.jar`, per the
`agent-<variant>-<mc>.jar` convention).

## Build (acceptance-only — needs Loom + network)

The core must be published to mavenLocal first:

```
# in /agents
gradle :core:build :core:publishToMavenLocal

# in /agents/server-fabric (standalone build; NEEDS NETWORK + LOOM — not run in this repo's CI)
gradle build
```

The remapped mod jar `build/libs/agent-server-fabric.jar` shades the core + Java-WebSocket **+ Gson** via
Loom `include(...)` (jar-in-jar). Note the **Gson** difference from `server-bukkit`: Paper ships Gson at
runtime (so the Bukkit agent keeps it `compileOnly`), but a vanilla Fabric **dedicated server** does not
reliably expose Gson to our classes, so this build **shades Gson in** to guarantee the envelope/JSON code
resolves at runtime. The jar is dropped into the server's `mods/` alongside the SUT mod (and Carpet for
`fakePlayers`). On start the agent logs **`MCTP listening on :PORT`** — the line the runner scrapes to
learn the port. The MCTP port is read from env **`MCTEST_AGENT_PORT`** (default `25575`, matching the
Bukkit agent's `config.yml`), bound on `127.0.0.1`.
