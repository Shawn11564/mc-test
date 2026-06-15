# mc-test-agent-bukkit

The **server-side mc-test agent** for Spigot/Paper: a thin Bukkit plugin that hosts an MCTP WebSocket
server and answers the server-truth / fixtures / fake-player half of the protocol. PROTOCOL.md is the
single source of truth for the wire; this module only binds Bukkit primitives behind the advertised
handlers. All intelligence (negotiation, error mapping, the dispatch loop) lives in the shared
`io.mctest:mc-test-agent-core`.

> **Bukkit/Paper API only.** No `net.minecraft.*` / NMS / Mojang-mapped symbols appear here, so the
> agent needs no per-version remap and the same jar runs across MC versions that share the Bukkit API.
> Fake players are driven via the Carpet `/player` console command, not NMS.

## Capabilities advertised

`agent.kind = serverPlugin`, with exactly:

| Capability | Methods | Detail |
|---|---|---|
| `worldTruth` | `truth.getWorldBlock`, `truth.getEntities` | `radiusLimit: 64`, `version: 1` |
| `pluginState` | `truth.assertPluginState` | — |
| `fixtures` | `fixture.set`, `fixture.reset` | — |
| `fakePlayers` | `player.spawnFake`, `player.despawnFake` | `backend: "carpet"` |
| `chat` | (advertised for co-selection; chat events come from the UI driver) | — |
| `testIdTags` | `testId` selector resolution carriers for SUTs we control | — |

The universal `session.*` + `world.join`/`world.leave` group is handled by the core `Dispatch`;
`world.join` is a no-op that transitions the session to Connected (the plugin is already in-process).

## The 7 handlers (all Bukkit access on the server thread)

Every handler bounces its game access onto the Bukkit main thread via `MainThread.call(plugin, body,
timeoutMs)` (`Bukkit.getScheduler().callSyncMethod(...).get`); a main-thread overrun maps to
`-32003 TIMEOUT`.

- **`truth.getWorldBlock`** (`truth/WorldTruth`) — `World#getBlockAt` → `{ type, properties?, biome }`
  (`type` is the `minecraft:lowercase` material id; `properties` parsed from the `BlockData` string
  form, never NMS). Out-of-range Y / unloaded chunk / unknown world → `-32004 WORLD_NOT_READY`.
- **`truth.getEntities`** (`truth/WorldTruth`) — `World#getNearbyEntities` filtered to a sphere; maps
  to `{ id, uuid, type, name?, position, tags?, customNameRaw? }`. `radius` above the granted
  `worldTruth.radiusLimit` → `-32602 invalidParams`.
- **`truth.assertPluginState`** (`truth/PluginStateProbe`) — resolves the value via the SUT's
  `McTestStateProvider` (looked up through the Bukkit `ServicesManager`), evaluates the optional
  `expect` predicate with the core `Predicates`, and returns `{ query, value, matched, valueJson }`.
  With no provider it falls back to a tiny grammar (`config.get`, `perms.has`). Unknown query / eval
  failure → `-32006 ASSERT_FAILED`.
- **`fixture.set`** (`fixtures/FixtureManager`) — built-in recipes `gamerule`, `time`, `weather`,
  `inventory` (give/clear), `permissions` (grant/revoke); any other fixture a registered
  `McTestFixtureProvider#supports` is delegated to that provider (e.g. `regions.createRegion`). Each
  apply records an undo in a per-session `FixtureLedger`. Unknown/failed → `-32005 FIXTURE_FAILED`;
  bad args → `-32602`.
- **`fixture.reset`** (`fixtures/FixtureManager`) — with `fixtureId` reverts one handle, otherwise
  reverts all session fixtures (LIFO). `snapshot` restore is not supported by this build →
  `-32005 FIXTURE_FAILED` (honest, not a false green).
- **`player.spawnFake`** / **`player.despawnFake`** (`players/FakePlayerManager`) — Carpet console
  command backend (`/player <name> spawn at <x> <y> <z>`, `/player <name> kill`); fakes are tracked
  per session and despawned on `session.close`.

Per-session resources (applied fixtures, spawned fakes) are released automatically on `session.close`
and on socket close via the core `ResourceRegistry`.

`gui/ServerGuiBridge` is an optional tiny `InventoryOpenEvent` listener that records the last
server-side inventory opened (for cross-checks); it exposes no MCTP method.

## SUT integration (the SPIs)

A System Under Test exposes real state and custom fixtures by implementing the **pure-Java** SPIs from
the core and registering them with the Bukkit `ServicesManager`:

```java
getServer().getServicesManager().register(
    McTestStateProvider.class, new RegionsStateProvider(store), this, ServicePriority.Normal);
getServer().getServicesManager().register(
    McTestFixtureProvider.class, new RegionsFixtureProvider(store), this, ServicePriority.Normal);
```

Because the SUT compiles against `mc-test-agent-core` at **provided** scope (not bundled), it loads the
*same* `McTestStateProvider`/`McTestFixtureProvider` classes the agent loads, so the lookup resolves.
See `examples/regions/plugin`.

## Configuration

`plugin.yml` name is **`mc-test-agent`**. The MCTP port is read from
`plugins/mc-test-agent/config.yml`:

```yaml
port: 25575       # overridden per target by the runner's provisioning
host: 127.0.0.1   # loopback only by default
```

The runner provisions this file with the per-target port it allocated (distinct from the game port),
boots the server, then learns the bound port from the `MCTP listening on :<port>` log line.

## Build

From the `agents/` directory (system Gradle, JDK 21; sources compiled to Java 17). The core must be
published to mavenLocal first (it is a project dependency wired by Component A):

```
gradle :core:build :core:publishToMavenLocal
gradle :server-bukkit:build
```

The fat jar `build/libs/mc-test-agent-bukkit.jar` bundles Java-WebSocket + the core (incl. the SPIs)
and **excludes** `paper-api`/`gson` (both `compileOnly`; Paper provides them at runtime). The
build-artifact convention is `mc-test-agent-bukkit.jar` (versioned form `agent-server-bukkit-<mc>.jar`).

Tests are pure-logic (no MockBukkit, no Bukkit runtime): `StateQueryTest`, `FixtureLedgerTest`,
`ParamsTest` cover the grammar parse, undo bookkeeping, and JSON ↔ param coercion. The cross-driver
conformance bar lives in `agents/core` (`ConformanceTest`).
