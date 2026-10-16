# mc-test-server-neoforge

The **server-side mc-test agent** for **NeoForge dedicated servers** (the NeoForge twin of
`server-fabric` / `server-forge` / `server-bukkit`): a thin server mod that hosts an MCTP WebSocket
server and answers the **world-truth / fixtures / plugin-state** half of the protocol. PROTOCOL.md is the
single source of truth for the wire; this module only binds NeoForge **server** primitives behind the
advertised handlers. All intelligence (negotiation, error mapping, the dispatch loop) lives in the shared
`io.mctest:mc-test-agent-core`.

`agent.kind = serverMod` (the Bukkit plugin advertises `serverPlugin`; this is its NeoForge server-mod
twin, DRIVERS.md §3).

> **This module is a thin shim.** It mirrors the **wiring** of `/agents/server-fabric`
> (`McTestServerMod`) but binds Mojmap-mapped NeoForge server APIs instead of Yarn-mapped Fabric ones.
> Per Prime Directive 2, fan-out (other MC versions) re-implements **only `mappings/Names.java`**; the
> core, the handler skeleton, and the pure-Java helpers are unchanged.
>
> **Fake players are native here (spec/42)**, as on the fabric/bukkit twins: `player.spawnFake`,
> `player.despawnFake`, `player.act`, `player.list`, `player.menu` and the in-game `/actor` command, with no
> Carpet mod. See [Fake players (actors)](#fake-players-actors).

## Build (standalone Gradle build — needs NeoGradle + network)

NeoGradle downloads Minecraft + NeoForge and needs the **network** and a real **dedicated server
runtime** to build and run. So this is a **standalone Gradle build** (its own `settings.gradle.kts`,
**not** part of `agents/settings.gradle.kts`), like `agents/client-forge`, `agents/client-neoforge`,
and `agents/server-fabric`. The CI `e2e.yml` modded-server lane builds this agent (NeoForge 21.1.234
on Java 21) and runs the harness: a real dedicated server boots, downloads FerriteCore from Modrinth
into `mods/`, and asserts `mod.loaded = true` over MCTP via the cost-1 `server` driver (no player join).

The loader-neutral wire logic and the pure-Java handler skeleton also live in `/agents/core` (the
cross-driver `ConformanceTest`) and in `/agents/server-bukkit`, from which this module is mirrored.
The pure-Java pieces shared between the server agents (`Params`, `StateQuery`, `FixtureLedger`,
`AppliedFixture`) are copied byte-for-byte from `server-fabric` (only the package declaration differs).
What needs a real NeoForge server (live `ServerLevel`, game rules, inventories) uses Mojmap mappings.

> **Mojmap spellings are build-verified.** NeoForge ships Mojang (official) names at dev AND runtime
> (so, unlike Forge, there is **no** SRG reobfuscation step). The method spellings in
> `mappings/Names.java` compiled against the real NeoForge 1.21.1 Mojmap mappings, and the lifecycle +
> `mod.loaded` path is runtime-proven by a real dedicated-server boot.

## Capabilities advertised

`agent.kind = serverMod`, with the full `serverMod` bundle (PROTOCOL.md §6.1–§6.2; mirrors
`SERVER_NEOFORGE_CAPABILITIES` in the runner's `cli.ts`):

| Capability | Methods | Detail |
|---|---|---|
| `worldTruth` | `truth.getWorldBlock`, `truth.getEntities` | `radiusLimit: 64`, `version: 1` |
| `pluginState` | `truth.assertPluginState` | — |
| `fixtures` | `fixture.set`, `fixture.reset` | — |
| `chat` | (advertised for co-selection; chat events come from the UI driver) | — |
| `testIdTags` | `testId` selector resolution carriers for SUTs we control | — |
| `fakePlayers` | `player.spawnFake`, `player.despawnFake`, `player.act`, `player.list`, `player.menu` | `backend: "native"`, `persist`, `list`, `menu`, `verbs` |

It does **not** advertise `clientScreens` / `containerGui` / `screenshot` (a dedicated server has no
client UI). Pair with `client-neoforge` for the rendered-GUI half
(the runner unions the co-selected agents' caps; missing caps **skip honestly**).

The universal `session.*` group and `world.join` / `world.leave` are handled by the core `Dispatch`;
`world.join` is a no-op that transitions the session to Connected (the agent is already in the server
process). The entrypoint registers **no** `session.*` or `world.*` methods itself — only the five above.

## The 5 handlers (all game access on the server thread)

Every handler bounces its game access onto the Minecraft **server thread** via `Names.call(body,
timeoutMs)` — the NeoForge analogue of the fabric agent's bounce, implemented with
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
  non-built-in query is unknown → `-32006 ASSERT_FAILED` (a vanilla NeoForge server has no Bukkit-style
  config/perms fallback).
- **`fixture.set`** (`fixtures/FixtureManager`) — built-in recipes `gamerule`, `time`, `weather`,
  `inventory` (give/clear); any other fixture a registered `McTestFixtureProvider#supports` is delegated
  to that provider (e.g. `regions.createRegion`). Each apply records an undo in a per-session
  `FixtureLedger`. The `permissions` recipe is **unsupported** here (no vanilla NeoForge per-player
  permission API) — delegated to a provider when one claims it, otherwise `-32005 FIXTURE_FAILED`
  (honest, not a false green). Unknown/failed → `-32005 FIXTURE_FAILED`; bad args → `-32602`.
- **`fixture.reset`** (`fixtures/FixtureManager`) — with `fixtureId` reverts one handle, otherwise
  reverts all session fixtures (LIFO). `snapshot` restore is not supported by this build →
  `-32005 FIXTURE_FAILED`.

## Fake players (actors)

An actor is a real `ServerPlayer` joined through `PlayerList.placeNewPlayer` behind a connection that
discards every packet (`mappings/Names.java`, `players/FakePlayerManager.java`). Identity is the offline
UUID of its name, so an actor's playerdata, inventory and position persist across sessions.

- **Ticking and respawning.** A per-tick pump (`Names.installActorPump`, `ServerTickEvent.Post`) runs
  each actor's `doTick` (movement, regeneration, item ticks: a held map fills in) and the Carpet
  keep-alive cadence, since the server's connection listener never ticks a discard connection. A dead
  actor respawns through the client's own respawn packet. It's a pump, as on bukkit, rather than a
  `ServerPlayer` subclass because `PlayerList.respawn` builds a new, plain `ServerPlayer`.
- **Network channels.** The actor's channel claims every payload channel (`ChannelAttributes.ADHOC_CHANNELS`).
  NeoForge throws on a custom payload sent to a client that never agreed to its channel, and an actor
  never negotiates one, so without this a mod that sends packets to joining players (Sable) or to
  players tracking its entities stops the actor joining.
- **Real players stay out of reach.** The roster goes by name, so every verb, `player.menu`, `player.list`
  and despawn also checks that the online player of that name is still behind a discard connection. An
  actor disconnected by a duplicate login or `/kick`, whose name a real player then took, is reported
  offline and can't be driven or removed.
- **Aiming.** `useblock` and `mine` without coordinates ray-cast from the actor's current eyes and
  rotation. `/tp <actor> … facing <pos>` from a command aims the actor's *feet* at the target, so use
  `/actor <name> look <x y z>` (eyes) or the coordinate forms instead.
- **Sends complete.** A discarded packet's send listener still runs, as a real channel's would, so
  `/kick` and server shutdown disconnect an actor through the real leave path.
- **What an actor is told.** Chat lines, action-bar messages and titles sent to an actor are echoed, as
  plain text prefixed with its name, to every online operator who isn't an actor, and to the server log
  (`[actor Bob] …`). One message broadcast to several actors in a tick is echoed once; vanilla join,
  leave and death messages (which everyone receives anyway) are skipped. `/actor <name> echo off`
  silences one actor.

`/actor` (op level 2) is the in-game front door: `spawn`, `remove`, `list`, and per actor `here`,
`look [<x y z>]`, `chat`, `cmd`, `attack`, `use`, `useblock [<x y z>]` (the faced block, or that block's
top face, as `interactBlock` does), `slot`, `click`/`rclick`/`shiftclick` (an ambiguous text points at
`slot <n>`, since there's no index argument in game), `menu` (every
labelled slot of the open menu with its lore), `give`, `hold`, `sneak`, `sprint`, `gamemode`, plus
in-game-only conveniences no `player.act` verb backs yet: `useitem [offhand]` (right-click in the air),
`mine [<x y z>]` (break the faced or given block through the real `destroyBlock`, so break events fire;
mining time isn't simulated), `drop [all]`, `hotbar <1-9>` (hold what an actor already carries; `hold` makes a new item)
and `echo on|off`.
Tab completes actor names, online players for `attack`/`use`, and the command after `cmd` as the actor
sees it (its own permission level); `tests/e2e/run-bench-actors.mjs` step 3a checks it with a real client.

The pump, respawning, channel claim, completed sends and echo were checked live on a NeoForge 1.21.1
server running MapFactions with Sable, Hundred Years Warfare, MCA Reborn, Create and Numismatics
(2026-10-08). They are NeoForge-only so far; the fabric and forge agents still tick through a
`ServerPlayer` subclass and don't respawn or echo.

Per-session resources (applied fixtures) are released automatically on `session.close` and on socket
close via the core `ResourceRegistry`.

## SUT integration — the SPIs via `ServiceLoader` (the NeoForge discovery mechanism)

A System Under Test exposes real state and custom fixtures by implementing the **pure-Java** SPIs from
the core (`McTestStateProvider`, `McTestFixtureProvider`). The Bukkit agent resolves them through the
Bukkit `ServicesManager`; **NeoForge has no such registry**, so this agent uses
**`java.util.ServiceLoader`** (exactly like `server-fabric`). A SUT mod ships a provider declaration:

```
# META-INF/services/io.mctest.agent.core.McTestStateProvider
com.example.regions.RegionsStateProvider

# META-INF/services/io.mctest.agent.core.McTestFixtureProvider
com.example.regions.RegionsFixtureProvider
```

`mappings/Names.java#lookupStateProvider()` / `lookupFixtureProvider()` call
`ServiceLoader.load(SPI.class, getClass().getClassLoader())` and return the first registered provider.
Because both the SUT mod and the nested agent core load the **same** SPI class on the common mod
classloader, the lookup resolves. Without a provider, `truth.assertPluginState` honestly fails
(`ASSERT_FAILED`) for non-built-in queries and SUT-specific fixtures fall back to built-in recipes only.

## Server-lifecycle usage

The dedicated server is captured via NeoForge's **server-lifecycle events**
(`ServerStartingEvent` / `ServerStartedEvent` / `ServerStoppingEvent` on `NeoForge.EVENT_BUS`, owned
inside `mappings/Names.java`): the agent starts its MCTP server on `ServerStartedEvent` (so the server
thread exists for the `Names.call` bounce) and stops it on `ServerStoppingEvent`, capturing the
`MinecraftServer` from `event.getServer()`. World/entity truth uses the server-thread `ServerLevel`
directly, matching the fabric/bukkit agents' runtime-state reads.

## The mappings quarantine (Prime Directive 2)

`mappings/Names.java` is the **ONLY** file allowed to import `net.minecraft.*` / Mojmap / NeoForge
symbols (`MinecraftServer`, `ServerLevel`, `BlockState`, `Property`, `GameRules`, `ResourceLocation`,
`BuiltInRegistries`, the `ServerStarted/StoppingEvent`s, …). `McTestServerMod` imports **only** the
shared core, the serverneoforge handler classes (pure Java over the `Names` façade), and the NeoForge
`@Mod` annotation. The handler classes (`WorldTruth`/`PluginStateProbe`/`FixtureManager`) import only
`io.mctest.agent.core.*` + the `Names` façade and its plain DTOs — never a Minecraft type.

A CI **import-scan** greps this module's sources and **fails** if any `net.minecraft.*` / Mojmap import
appears outside `mappings/Names.java`. This keeps the per-version obfuscation tax confined to one file.
The base name is `agent-server-neoforge` (resolver/install form `agent-server-neoforge-<mc>.jar`, per the
`agent-<variant>-<mc>.jar` convention).

## Building the jar (needs NeoGradle + network)

The core must be published to mavenLocal first:

```
# in /agents
gradle :core:build :core:publishToMavenLocal

# in /agents/server-neoforge (standalone build; NEEDS NETWORK + NeoGradle)
gradle build
```

The **jarJar** mod jar `build/libs/agent-server-neoforge.jar` nests the core + Java-WebSocket
(NeoForge's jar-in-jar; NeoForge has no Loom `include`, but its `jarJar` is the equivalent). **Gson is
NOT nested in:** the loader/Minecraft already provides `com.google.gson` as a module on the boot module
path, so bundling it split the module graph at boot. Gson is therefore a **compile-only** dependency
here. `slf4j` is **excluded** from the nested
Java-WebSocket (NeoForge already provides an `org.slf4j` module under the JPMS module system; bundling it
would split the package at boot). Unlike Forge, NeoForge runs Mojmap at runtime, so there is **no
reobfuscation step** — the jar `mappings/Names.java` was compiled against IS what the server runs.

The jar is dropped into the server's `mods/` alongside the SUT mod. On start the agent logs
**`MCTP listening on :PORT`** — the line the runner scrapes to learn the port. The MCTP port is read from
env **`MCTEST_AGENT_PORT`** (default `25575`, matching the fabric/bukkit agents), bound on `127.0.0.1`.
The runner's `KNOWN_AGENTS` already references
`agents/server-neoforge/build/libs/agent-server-neoforge.jar` and **honest-skips** the server-truth steps
when that jar is absent (the cost-1 `server` driver needs an agent).
