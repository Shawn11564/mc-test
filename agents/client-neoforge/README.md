# mc-test-client-neoforge

The **client-side mc-test agent** for NeoForge: a thin client mod that hosts an MCTP WebSocket server and
exposes the **real client's Screen/widget tree, keyboard, and framebuffer** as MCTP primitives. This is
the half of the in-process driver that lives inside Minecraft; the runner-side adapter is
`/packages/driver-inprocess`. PROTOCOL.md is the single source of truth for the wire; this module only
binds Mojmap-mapped client internals behind the advertised handlers. All intelligence (negotiation,
selector resolution, retries, assertions, error mapping, the dispatch loop) lives in the shared
`io.mctest:mc-test-agent-core` — including the loader-neutral `screen.*` / client-side `world.*`
handlers (`ScreenHandlers`) and the `ClientBridge` façade this shim implements.

> **This module is a thin shim.** It ships exactly three things: the entrypoint
> (`McTestClientMod`), the Mojmap-mapped `ClientBridge` impl (`mappings/Names.java`), and
> `META-INF/neoforge.mods.toml`. Per Prime Directive 2, this NeoForge shim re-implements **only
> `mappings/Names.java`** versus `/agents/client-fabric` — the core is unchanged, and the entrypoint
> differs only in the loader seam (`@Mod` + EventBus instead of `ClientModInitializer`).

## ⚠️ Acceptance-only build (not built in this repo's CI)

NeoGradle downloads Minecraft + NeoForge and needs the **network** and a **real client runtime** to
build and run. So this is a **standalone Gradle build** (its own `settings.gradle.kts`, **not** part of
`agents/settings.gradle.kts`), and it is **not** compiled in this repo's CI — `gradle :core:build
:server-bukkit:build` stays fast and offline. The sources here are written to be correct against the
contract but are validated by inspection, not by a build in this environment (exactly like
`agents/client-fabric` and `examples/regions/mod`).

The **CI-provable** half of the client agent — the loader-neutral `ScreenHandlers` + `ClientBridge`
façade — lives in `/agents/core` and is exercised there by `ScreenConformanceTest` with a
`FakeClientBridge` (no Minecraft). What needs a real rendered client (live Screens, a PNG framebuffer,
Xvfb) is acceptance-only.

## Capabilities advertised

`agent.kind = clientMod`, built by `io.mctest.agent.core.client.ClientCapabilities.build(hasFramebuffer)`
(DRIVERS.md §2.1):

| Capability | Methods | Notes |
|---|---|---|
| `clientScreens` | `screen.get`, `screen.listElements`, `screen.clickElement`, `screen.waitForScreen`, `screen.close` | the differentiator — real client Screens (`capabilityDetails.clientScreens = { widgetTree: true }`) |
| `containerGui` | (co-selection) | the client also renders container screens |
| `typeText` | `screen.typeText` | per-char replay so SUT change-listeners fire |
| `pressKey` | `screen.pressKey` | GLFW key dispatch through the current screen |
| `chat` | `world.sendChat`, `world.waitForChat` | client chat tap (`ClientChatReceivedEvent`) |
| `command` | `world.runCommand` | `sendCommand` (no leading `/`) |
| `testIdTags` | `testId` selector resolution | reads `widget instanceof TestIdHolder` |
| `screenshot` | `screen.screenshot` | **only when a framebuffer exists** (`capabilityDetails.screenshot = { format:["png"] }`) |
| `rendering` | (implies a real framebuffer) | **only when a framebuffer exists** |

It does **not** advertise `worldTruth` / `pluginState` / `fixtures` / `fakePlayers` — a client mod cannot
author server plugin state. Pair with `server-bukkit` / `server-fabric` for those (the runner unions the
co-selected agents' caps; missing caps **skip honestly**).

The universal `session.*` group and `world.join` / `world.leave` are handled by the core `Dispatch`;
`world.join` is routed through a **world hook** (`ClientAgent.buildDispatch`) into
`ClientBridge.joinServer/leaveServer`, so the client actually connects to the target server.

## How it pairs in the regions example

For the **client-rendered** regions mod (`examples/regions/mod`, the case headless cannot see):

1. `world.runCommand("or")` → the mod opens its custom `RegionsScreen`.
2. `screen.waitForScreen({ titleContains: "Regions" })`.
3. `screen.clickElement({ testId: "regions:root:regions" })` → the "Regions" `Button` (`TestIdHolder`);
   click dispatched on the render thread.
4. `screen.clickElement({ testId: "regions:entry:TestRegion" })` → the "TestRegion" list entry.
5. `world.waitForChat({ contains: "Region loaded" })`.
6. The server-truth half (`truth.assertPluginState`) runs on a paired server agent (mock in CI,
   `server-fabric` in M5); without one it skips honestly with `unmet:["pluginState"]`.

## The mappings quarantine (Prime Directive 2)

NeoForge ships **OFFICIAL Mojang mappings (Mojmap)**: the per-version tax is the official deobf names
themselves (e.g. `Minecraft`, `Screen`, `AbstractWidget`, `Button`, `EditBox`, `Component.getString()`,
`Screenshot`, `ConnectScreen.startConnecting`, GLFW). `mappings/Names.java` is the **ONLY** file allowed
to import `net.minecraft.*` / Mojmap / GLFW symbols. `McTestClientMod` imports **only** the shared core
and the NeoForge loader entrypoint/event API (`net.neoforged.fml.* / net.neoforged.bus.* /
net.neoforged.api.distmarker.*`).

A CI **import-scan** (in `packages/runner/test/m4.test.ts`) greps this module's sources and **fails** if
any `net.minecraft.*` / Mojmap import appears outside `mappings/Names.java`. This keeps the per-version
obfuscation tax confined to one file so M5 can fan out by swapping only that file (and the build's
mapping coordinates).

Because Mojmap names can drift between MC versions, `mappings/Names.java` (and the `minecraft` /
`neoforge` versions pinned in `build.gradle.kts`) is the per-`(loader × MC)` artifact. The base name is
`agent-client-neoforge` (resolver/install form `agent-client-neoforge-<mc>.jar`, per the
`agent-<variant>-<mc>.jar` convention; `mc-test.example.yml` references exactly this path).

## EventBus wiring (the seam)

NeoForge has **two** event buses — the **mod event bus** (lifecycle: `FMLClientSetupEvent`, passed to the
`@Mod` constructor) and the **game/NeoForge event bus** (`NeoForge.EVENT_BUS`: runtime gameplay events
like `ClientChatReceivedEvent`). The entrypoint subscribes its setup listener on the **mod event bus**;
`Names` subscribes its chat tap on the **game event bus**. That is the loader seam that replaces Fabric's
`ClientModInitializer.onInitializeClient()` + Fabric API callbacks.

Independently, the MCTP `event.*` path is identical to the Fabric shim: `MctpServer` owns an internal
`EventBus` wired to its connection `broadcast`, while the loader-neutral `ScreenHandlers` (registered by
`ClientAgent.buildDispatch`) emit `event.screenChanged` / `event.chat` through a bus passed in at
dispatch-build time. To make those emits reach the wire, `McTestClientMod`:

1. creates a fresh `EventBus events`,
2. builds the `Dispatch` with it (`ClientAgent.buildDispatch(bridge, events, …)`),
3. constructs `MctpServer(host, port, dispatch, log)`,
4. points the handlers' bus at the server's transport: `events.setBroadcaster(server::broadcast)`.

`MctpServer.broadcast(String)` (inherited from the Java-WebSocket server) fans one notification frame to
every open connection — exactly `EventBus.Broadcaster`'s contract.

## Build (acceptance-only — needs NeoGradle + network)

The core must be published to mavenLocal first (Component A):

```
# in /agents
gradle :core:build :core:publishToMavenLocal

# in /agents/client-neoforge (standalone build; NEEDS NETWORK + NeoGradle — not run in this repo's CI)
gradle build
```

The mod jar `build/libs/agent-client-neoforge-<version>.jar` nests the core + Java-WebSocket via
NeoGradle `jarJar(...)` (jar-in-jar), so the running client carries the MCTP server without a separate
jar. It is launched into a real Minecraft client's `mods/` alongside the SUT mod by `driver-inprocess`
(offline: `--username Tester --uuid <z> --accessToken 0`), under a desktop runner or Xvfb. On start the
agent logs **`MCTP listening on :PORT`** — the line `driver-inprocess` scrapes to learn the port.
