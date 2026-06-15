# mc-test-agent-core

The shared, loader-neutral Java core for every `mc-test` in-game agent — the **MCTP server side**
(PROTOCOL.md is the single source of truth for the wire). It is pure data + dispatch + WebSocket
transport: **no game, Bukkit, or Mojang-mapped types** appear here, so per-loader shims
(`/agents/server-bukkit`, `/agents/client-*`) stay tiny and dumb.

Published to mavenLocal as `io.mctest:mc-test-agent-core:0.1.0`.

## What lives here

| Class / interface | Responsibility |
|---|---|
| `MctpServer` | WebSocket server (Java-WebSocket). Accepts only sub-protocol `mctp.v1` on path `/mctp`, parses one JSON-RPC envelope per frame, routes via `Dispatch`, echoes `id`. Exposes `events()`. Logs `"MCTP listening on :<port>"` on start. |
| `Dispatch` | Method router + session/capability state machine. Handles `session.*` and `world.join`/`world.leave` itself; gates registered primitives by required capability (`-32002` when ungranted). |
| `Capabilities` | Advertised key set + `capabilityDetails`; `negotiate(required, optional)` → granted/denied split. |
| `McTestSession` (+ `ResourceRegistry`) | Per-connection session; LIFO cleanup registry released on `session.close`/socket close. |
| `PrimitiveHandler` | `JsonObject handle(session, params)` — one primitive per method. |
| `Predicates` | Pure `expect` evaluator (`equals|notEquals|contains|gt|gte|lt|lte|exists`) for `truth.assertPluginState`. |
| `SelectorMatch` + `ElementModel` | AND selector matcher + element/screen DTOs (M4 reuse; unit-tested). |
| `Errors` / `McTestException` / `JsonRpc` | Canonical error codes + reasons, typed failures, envelope builders. |
| `EventBus` | Broadcasts `event.*` notifications to connected clients. |
| `LogSink` | Loader-neutral logging seam. |
| `McTestStateProvider` / `McTestFixtureProvider` | **SPIs the SUT implements** (pure Java) to expose real plugin state + custom fixtures. Shared via this artifact so the agent and SUT load the *same* class. |

## Build / publish

From the `agents/` directory (system Gradle 9.x, JDK 21; sources compiled to Java 17):

```
gradle :core:build :core:publishToMavenLocal
```

`build` runs the unit + conformance tests (`ConformanceTest`, `PredicatesTest`, `SelectorMatchTest`,
`CapabilitiesNegotiationTest`). `ConformanceTest` boots a real `MctpServer` with stub
`truth.*`/`fixture.*`/`player.*` handlers and replays the golden fixtures under
`packages/protocol/fixtures/conformance/methods/*.json` over a real WebSocket client.

## Dependency rules

- `org.java-websocket:Java-WebSocket:1.5.7` — `implementation` (bundled into agent fat-jars downstream).
- `com.google.code.gson:gson:2.11.0` — `compileOnly` (Paper provides Gson at runtime; not bundled).
- JUnit Jupiter 5 — test only.
