# mc-test-client-forge

The **client-side mc-test agent** for Forge: a thin client mod that hosts an MCTP WebSocket server and
exposes the **real client's Screen/widget tree, keyboard, and framebuffer** as MCTP primitives. This is
the half of the in-process driver that lives inside Minecraft; the runner-side adapter is
`/packages/driver-inprocess`. PROTOCOL.md is the single source of truth for the wire; this module only
binds MCP-SRG/official-name client internals behind the advertised handlers. All intelligence
(negotiation, selector resolution, retries, assertions, error mapping, the dispatch loop) lives in the
shared `io.mctest:mc-test-agent-core` — including the loader-neutral `screen.*` / client-side `world.*`
handlers (`ScreenHandlers`) and the `ClientBridge` façade this shim implements.

It is the **exact Forge twin of `/agents/client-fabric`** — same 8-step entrypoint wiring, same
`mappings/Names.java` logic — differing only in the loader-specific bits: a Forge `@Mod` with an
`FMLClientSetupEvent` (mod event bus, `Dist.CLIENT`) instead of a Fabric `ClientModInitializer`, the
MCP-SRG/official-name Minecraft client API instead of Yarn, the Forge client event bus
(`ClientChatReceivedEvent`) instead of `ClientReceiveMessageEvents`, and `mods.toml` instead of
`fabric.mod.json`.

> **This module is a thin shim.** It ships exactly three things: the entrypoint
> (`McTestClientMod`), the MCP-SRG/official-name `ClientBridge` impl (`mappings/Names.java`), and
> `META-INF/mods.toml`. Per Prime Directive 2, M5 fan-out (other MC versions) re-implements **only
> `mappings/Names.java`** (and the build's mapping coordinates) — the core is unchanged.

## ⚠️ Acceptance-only build (not built in this repo's CI)

ForgeGradle downloads Minecraft + MCP/official mappings + the Forge userdev and needs the **network**
and a **real client runtime** to build and run. So this is a **standalone Gradle build** (its own
`settings.gradle.kts`, **not** part of `agents/settings.gradle.kts`), and it is **not** compiled in
this repo's CI — `gradle :core:build :server-bukkit:build` stays fast and offline. The sources here are
written to be correct against the contract but are validated by inspection, not by a build in this
environment (exactly like `examples/regions/mod` and `agents/client-fabric`).

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
| `chat` | `world.sendChat`, `world.waitForChat` | client chat event tap |
| `command` | `world.runCommand` | `sendCommand` (no leading `/`) |
| `testIdTags` | `testId` selector resolution | reads `widget instanceof TestIdHolder` |
| `screenshot` | `screen.screenshot` | **only when a framebuffer exists** (`capabilityDetails.screenshot = { formats:["png"] }`) |
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
3. `screen.clickElement({ testId: "regions:root:regions" })` → the "Regions" `Button`
   (`TestIdHolder`); click dispatched on the render thread.
4. `screen.clickElement({ testId: "regions:entry:TestRegion" })` → the "TestRegion" list entry.
5. `world.waitForChat({ contains: "Region loaded" })`.
6. The server-truth half (`truth.assertPluginState`) runs on a paired server agent (mock in CI,
   `server-fabric` in M5); without one it skips honestly with `unmet:["pluginState"]`.

## The mappings quarantine (Prime Directive 2)

`mappings/Names.java` is the **ONLY** file allowed to import `net.minecraft.*` / `com.mojang.*` /
GLFW-mapped symbols (`Minecraft`, `Screen`, `AbstractWidget`, `Button`, `EditBox`, `Screenshot`,
`ConnectScreen`, `Component`, `GLFW`, …). `McTestClientMod` imports **only** the shared core and the
Forge loader entrypoint/event API (`net.minecraftforge.fml.*`, `net.minecraftforge.eventbus.*`,
`net.minecraftforge.api.distmarker.*`) — none of which is obfuscation-mapped.

> Note on the Forge chat tap: the `@SubscribeEvent onClientChat(ClientChatReceivedEvent)` handler lives
> in `mappings/Names.java` (not the entrypoint), because its event payload (`net.minecraft.network.chat.Component`)
> is a mapped type. Forge's `ClientChatReceivedEvent` / `MinecraftForge.EVENT_BUS` themselves are
> `net.minecraftforge.*` (loader API, not mapped), but keeping the whole tap inside `Names.java` mirrors
> the Fabric shim and keeps the seam in one file.

A CI **import-scan** (in `packages/runner/test/m4.test.ts`) greps this module's sources and **fails** if
any `net.minecraft.*` / `com.mojang.{blaze3d,authlib,serialization,datafixers}` / `org.lwjgl.glfw`
import appears outside `mappings/Names.java`. This keeps the per-version obfuscation tax confined to one
file so M5 can fan out by swapping only that file (and the build's mapping coordinates).

Because mapped names drift between MC snapshots, `mappings/Names.java` (and the `minecraft` / `forge` /
`mappings` versions pinned in `build.gradle.kts`) is the per-`(loader × MC)` artifact. The base name is
`agent-client-forge` (resolver/install form `agent-client-forge-<mc>.jar`, per the
`agent-<variant>-<mc>.jar` convention).

## EventBus wiring (the seam)

`MctpServer` owns an internal `EventBus` wired to its connection `broadcast`. The loader-neutral
`ScreenHandlers` (registered by `ClientAgent.buildDispatch`) emit `event.screenChanged` / `event.chat`
through a bus passed in at dispatch-build time. To make those emits reach the wire, `McTestClientMod`:

1. creates a fresh `EventBus events`,
2. builds the `Dispatch` with it (`ClientAgent.buildDispatch(bridge, events, …)`),
3. constructs `MctpServer(host, port, dispatch, log)`,
4. points the handlers' bus at the server's transport: `events.setBroadcaster(server::broadcast)`.

`MctpServer.broadcast(String)` (inherited from the Java-WebSocket server) fans one notification frame to
every open connection — exactly `EventBus.Broadcaster`'s contract. (Identical to the Fabric shim's
documented seam.)

## Build (acceptance-only — needs ForgeGradle + network)

The core must be published to mavenLocal first (Component A):

```
# in /agents
gradle :core:build :core:publishToMavenLocal

# in /agents/client-forge (standalone build; NEEDS NETWORK + ForgeGradle — not run in this repo's CI)
gradle build
```

The shaded mod jar `build/libs/agent-client-forge.jar` shades the core + Java-WebSocket via the Shadow
plugin (Forge has no Loom `include` jar-in-jar), so the running client carries the MCTP server without a
separate jar. It is launched into a real Minecraft client's `mods/` alongside the SUT mod by
`driver-inprocess` (offline: `--username Tester --uuid <z> --accessToken 0`), under a desktop runner or
Xvfb. On start the agent logs **`MCTP listening on :PORT`** — the line `driver-inprocess` scrapes to
learn the port.
