# mc-test — Drivers

> Status: design doc. Audience: driver authors, runner authors, agent authors.
> This doc owns per-driver **capability sets**, **element/screen field shapes**, and **build-artifact naming**. It makes **no naming-precedence claim**: all MCTP wire spellings — method names, capability keys, selector keys, error codes, testId carriers, protocol version — are **defined by `PROTOCOL.md`** (the single source of truth). This doc only **uses** them; where it lists names (see the **Contract reference** at the end) it does so for convenience and defers to `PROTOCOL.md` for the definitions.

This document specifies the **four swappable drivers** that sit at the **bottom** of the mc-test "narrow waist". Each driver speaks exactly one stable contract — the **MC Test Protocol (MCTP)**, JSON-RPC 2.0 over WebSocket — and advertises a **capability set**. The runner (`/packages/runner`) performs Appium-style **capability negotiation**: a test declares the capabilities it requires, and the runner picks a compatible driver or **skips with a clear reason**.

The four drivers:

| # | Driver | Package / agent | Sees | Primary use |
|---|--------|-----------------|------|-------------|
| 1 | **Headless protocol bot** | `/packages/driver-headless` | server-truth, inventory GUIs, chat | Fast plugin tests in CI |
| 2 | **In-process client mod** | `/packages/driver-inprocess` + `/agents/client-fabric`, `/agents/client-forge`, `/agents/client-neoforge` | real client Screens/widgets, rendering, screenshots | Mod client GUIs (the only way) |
| 3 | **Server-side agent** | `/agents/server-bukkit`, `/agents/server-fabric` | native world-truth, plugin/mod state, fixtures, fake players | World/plugin assertions, setup |
| 4 | **Pixel / OCR driver** | `/packages/driver-pixel` | raw framebuffer pixels | Universal last resort |

Drivers 2 and 3 are **in-game agents**: tiny, dumb, version-specific Java/Kotlin processes that expose **primitives only**. Drivers 1 and 4 run **outside the game** entirely (driver-headless is a protocol client; driver-pixel reads a framebuffer). Per the prime directives, **all intelligence** — selectors, assertions, retries, orchestration, reporting — lives **outside** the game in version-independent runner code. Each driver below resolves the same **semantic selectors** in its own way.

---

## 0. Shared model: MCTP primitives, selectors, capabilities

### 0.1 The MCTP primitive surface (the full method list)

Every driver implements a subset of this method set. Methods are grouped by the capability that gates them. Exact wire names (used verbatim by all drivers and the runner):

**Session / negotiation (every driver MUST implement):**
- `session.create` — handshake; runner sends required capabilities + target descriptor; driver returns `{ driverId, driverKind, protocolVersion, capabilities, target }` or rejects. Negotiates `protocolVersion` (starting at `"1.0"`).
- `session.describe` — report current driver/session state `{ driverId, driverKind, protocolVersion, capabilities, target }`.
- `session.close` — tear down; release ports, world snapshot, processes.
- `session.ping` — liveness/keepalive.

**Screen / GUI primitives (gated by capabilities below):**
- `screen.listElements` — return all elements of the current screen/container as `Element[]` (see §0.3). When given a **selector** (§0.2), returns only matching elements; resolution happens **driver-side** and the selector grammar is shared.
- `screen.get` — return the current screen descriptor `{ screenId, title, kind, size, elementCount }`.
- `screen.clickElement` — resolve a selector to one element and click it (left-click by default; `button`/`shift` params optional).
- `screen.typeText` — type a string into the focused/targeted element (selector optional; defaults to focused widget).
- `screen.pressKey` — send a key/keychord (e.g. `"ESCAPE"`, `"ENTER"`, `"E"`).
- `screen.screenshot` — return a PNG (base64) of the current screen/framebuffer.
- `screen.waitForScreen` — block until a screen matching a predicate appears or timeout (server-side convenience; runner may instead poll `screen.get`).
- `screen.close` — close the current screen/container.

**Chat / command primitives:**
- `world.sendChat` — send a chat line.
- `world.runCommand` — run a slash command (e.g. `/or`).
- `world.waitForChat` — block until a chat line matching a predicate arrives or timeout. Recent chat lines `{ lines: [{ ts, raw, plain }] }` are also delivered via the `event.chat` notification.

**World / lifecycle primitives:**
- `world.join` — connect/join the target world.
- `world.leave` — disconnect/leave the world.

**World-truth primitives (server-side):** (result shapes per `PROTOCOL.md` §7.3 / §7.5)
- `truth.getWorldBlock` — `{ world?, x, y, z } -> { block: { type, properties?, nbtJson?, biome? } }`.
- `truth.getEntities` — query entities by `{ world?, center, radius, type? }` -> `{ count, entities: [{ id, uuid, type, name?, position, tags?, customNameRaw? }] }`.
- `truth.assertPluginState` — evaluate a named, plugin-registered probe by `query` (params `{ plugin?, query, args?, expect? }`, e.g. `query:"regions.exists"` `args:{name:"TestRegion"}`) and return `{ ok, query, value, matched, valueJson }`.

**Fixture / lifecycle primitives (server-side):**
- `fixture.set` — apply a named world/plugin fixture (place blocks, create regions, set time/weather, load a config).
- `fixture.reset` — clear/reset applied fixtures back to the pristine baseline.
- `player.spawnFake` — spawn a server-side fake/NPC player; returns a handle usable as an actor.
- `player.despawnFake` — despawn a fake player handle.

> A driver that does not implement a method MUST reject calls to it with JSON-RPC error `METHOD_NOT_SUPPORTED` (defined in `PROTOCOL.md`; recapped in the Contract reference). The runner never calls a method whose gating capability the driver did not advertise; `METHOD_NOT_SUPPORTED` is a defense-in-depth backstop.

### 0.2 Semantic selectors (shared grammar; resolved per-driver)

A **selector** is a JSON object. Never coordinates, never slot indices in the test author's hands. Each driver maps these keys onto its own substrate (inventory slot display-names; `ClickableWidget.getMessage()`; OCR boxes). Selector keys:

| Key | Meaning | Example |
|-----|---------|---------|
| `label` | exact visible label / display name | `{ "label": "Regions" }` |
| `text` | exact visible text (full-string match) | `{ "text": "Open Regions" }` |
| `textContains` | substring of visible text | `{ "textContains": "Region" }` |
| `loreContains` | substring within item lore / tooltip | `{ "loreContains": "owner: admin" }` |
| `itemType` | item/material id (inventory GUIs) | `{ "itemType": "minecraft:diamond" }` |
| `role` | semantic role | `{ "role": "button" }` |
| `index` / `nth` | disambiguate among matches (0-based) | `{ "textContains": "Region", "nth": 1 }` |
| `within` | scope to a sub-container/region selector | `{ "within": { "role": "list" }, "label": "TestRegion" }` |
| `testId` | invisible tag emitted by SUTs we control | `{ "testId": "regions:entry:TestRegion" }` |

`testId` is the most robust: a cooperating plugin/mod stamps an invisible **NBT key** `mctp:testId` (inventory items) or **data component** `mc-test:test_id` (1.20.5+) or a mod-side widget `testId` field, and drivers resolve it deterministically. Drivers that cannot read tags (pixel) ignore `testId` and fall back to `label`/`textContains` via OCR.

A selector resolving to **zero** elements on a `screen.clickElement` raises `ELEMENT_NOT_FOUND`; resolving to **more than one** without `nth`/`index` raises `AMBIGUOUS_SELECTOR`.

### 0.3 `Element` shape (returned by `screen.listElements`)

```jsonc
{
  "ref": "el-7",                 // opaque, screen-scoped handle (stable within a screen)
  "label": "Regions",            // best-effort visible text
  "role": "button",              // button | slot | label | input | tab | list | listItem
  "testId": "regions:list",      // present only if the SUT emitted one and the driver can read it
  "itemType": "minecraft:paper", // inventory GUIs only
  "lore": ["Click to open"],     // inventory GUIs / tooltips
  "enabled": true,
  "bounds": { "x": 10, "y": 20, "w": 100, "h": 18 } // client/pixel drivers only; null for bot
}
```

### 0.4 The capability vocabulary

Capability keys are **booleans** advertised by drivers and **required** by tests. Full vocabulary defined in `PROTOCOL.md` (recapped in the Contract reference):

| Capability key | Grants methods | Meaning |
|----------------|----------------|---------|
| `chat` | `world.sendChat`, `world.waitForChat` | send/read chat |
| `command` | `world.runCommand` | run slash commands |
| `containerGui` | `screen.listElements`/`screen.clickElement` over **container** screens | server-driven inventory menus (chest GUIs) |
| `clientScreens` | `screen.listElements`/`screen.clickElement`/`screen.get`/`screen.typeText`/`screen.pressKey` over **client** Screens | real client-rendered mod GUIs |
| `typeText` | `screen.typeText` | type text into a focused/targeted element |
| `pressKey` | `screen.pressKey` | raw key events |
| `screenshot` | `screen.screenshot` | pixel capture of current screen |
| `rendering` | (implies a real rendered client) | a GPU/Xvfb framebuffer exists |
| `worldTruth` | `truth.getWorldBlock`, `truth.getEntities` | authoritative server world state |
| `pluginState` | `truth.assertPluginState` | query SUT-registered probes |
| `fixtures` | `fixture.set`, `fixture.reset` | mutate world/plugin state for setup |
| `fakePlayers` | `player.spawnFake`, `player.despawnFake` | server-side actor automation |
| `testIdTags` | (read path for `testId` selector) | driver can read `testId` carriers structurally |

> A driver-local advertisement `pixelOnly` (NOT part of the canonical capability vocabulary) marks the pixel driver's visual resolution path; the runner treats it as a negotiation pin only, at lowest priority. See §4.1.

A test's `requires:` block lists capability keys; the runner intersects them with each candidate driver's advertised set and picks the **cheapest** satisfying driver (server < headless < in-process < pixel by default cost order — cost order is owned by `CAPABILITIES.md`), or **skips** with reason `NO_COMPATIBLE_DRIVER` carrying `unmet: ["clientScreens"]`.

---

## 1. Driver: Headless protocol bot (`driver-headless`)

**Package:** `/packages/driver-headless` (TypeScript).
**Kind:** `headless` (off-game protocol client; no rendered client, no in-game agent of its own — but pairs with `server-bukkit`/`server-fabric` for world-truth).
**Built on:** [Mineflayer](https://github.com/PrismarineJS/mineflayer) + [minecraft-data](https://github.com/PrismarineJS/minecraft-data) + [ViaVersion](https://github.com/ViaVersion/ViaVersion) / ViaProxy.

This is the **default CI driver**. It logs into the server as a real protocol-level player (offline-mode), can run commands, read chat, and drive **server-pushed inventory GUIs** (chest menus) by reading window items. It is fast, parallelizable, and needs no GPU. It **cannot** see client-rendered mod Screens because no client GUI exists — it is a bare protocol bot.

### 1.1 Capability set (advertised)

```jsonc
{
  "driverKind": "headless",
  "capabilities": {
    "chat": true,
    "command": true,
    "containerGui": true,
    "typeText": true,        // anvil/sign/book server-side text only; see §1.2
    "testIdTags": false,     // bot CAN read PDC testId, but M2 advertises only the 5 core caps (BUILD_PROMPT §M2)
    "screenshot": false,     // no framebuffer; see limits
    "rendering": false,
    "clientScreens": false,  // CANNOT — bare protocol, no client UI
    "worldTruth": "via-pair", // provided by paired server agent, not the bot itself
    "pluginState": "via-pair",
    "fixtures": "via-pair",
    "fakePlayers": "via-pair",
    "pressKey": true,        // M2: advertised (BUILD_PROMPT §M2). ESCAPE closes a window; other keys are no-ops on a bare bot
    "pixelOnly": false       // driver-local marker (non-canonical); always false here
  }
}
```

> `"via-pair"` means: the **bot** does not implement the method, but when the matrix target also provisions a `server-bukkit`/`server-fabric` agent, the runner routes `worldTruth`/`pluginState`/`fixtures`/`fakePlayers` calls to that agent over a second MCTP session. From the test's point of view the capability is satisfied. Negotiation treats `via-pair` as `true` **iff** a server agent is present in the target; otherwise `false`.

### 1.2 How it implements each MCTP primitive

| MCTP method | Implementation in driver-headless |
|-------------|-----------------------------------|
| `session.create` / `session.describe` / `session.close` / `session.ping` | Native. `session.create` creates a Mineflayer `bot` via `mineflayer.createBot({ host, port, username, version, auth: 'offline' })`, optionally through ViaProxy for cross-version. |
| `world.join` / `world.leave` | `world.join` connects the bot to the target server; `world.leave` calls `bot.quit()`. |
| `world.sendChat` | `bot.chat(line)` — plain chat. |
| `world.runCommand` | `bot.chat('/' + cmd)` — slash commands (e.g. `bot.chat('/or')`). |
| `world.waitForChat` | Buffer `bot.on('messagestr', ...)` / `bot.on('message', jsonMsg)`; blocks for a matching line and also emits `event.chat` with both `raw` (JSON/§-codes) and `plain` (stripped) forms. |
| `screen.get` | If `bot.currentWindow` is open → `{ screenId: window.id, title: window.title, kind: "container", size: window.inventoryStart, elementCount: filled slots }`. Else `{ kind: "none" }`. |
| `screen.listElements` | Enumerate `bot.currentWindow.slots`; each non-null slot → `Element { ref: "slot-"+i, label: item.customName ?? prettifyName(item), role: "slot", itemType: item.name (mcData), lore: item.customLore, bounds: null }`. With a selector, filters in-driver: `label`→display name equality; `textContains`→substring of display name; `loreContains`→substring across lore lines; `itemType`→`mcData` material id; `testId`→read NBT key `mctp:testId` (or `mc-test:test_id` component on 1.20.5+) from `item.nbt`; `nth`/`index`/`within` as defined. |
| `screen.clickElement` | Resolve to one slot index `i`, then `bot.clickWindow(i, button, mode)` (`mode 0` left, `button 1` for shift). For player-inventory hotbar items, `bot.setQuickBarSlot` / `bot.activateItem` as appropriate. |
| `screen.typeText` | Only meaningful for **anvil/sign/book** server-side text inputs the bot supports: `bot.writeBook`, anvil rename via `bot.setRenamedItem` (a.k.a. anvil API). For arbitrary client inputs → **not supported** (`METHOD_NOT_SUPPORTED`). |
| `screen.pressKey` | M2: advertised. `ESCAPE`/`ESC` closes the open window; other keys return `{ ok, screenChanged:false }` with a warning (a bare bot has no client to receive key events). |
| `screen.screenshot` | **Not supported** by default. Optional degraded mode renders an **ASCII/HTML inventory grid** artifact (slot map) for debugging — advertised separately as `inventoryGridSnapshot`, NOT as `screenshot`/`rendering`. |
| `screen.close` | `bot.closeWindow(bot.currentWindow)` if a container window is open; else no-op. |
| `truth.getWorldBlock` / `truth.getEntities` / `truth.assertPluginState` / `fixture.set` / `fixture.reset` / `player.spawnFake` / `player.despawnFake` | Routed to the paired server agent (`via-pair`). The bot itself only knows blocks/entities **within its own loaded view**; for authoritative truth the runner prefers the server agent. (A degraded `truth.getEntities` from `bot.entities` is available and advertised as `worldViewBot` for cases with no server agent.) |

### 1.3 Version strategy

- **minecraft-data** provides per-version protocol/material/window metadata; Mineflayer selects the right packet layer from the negotiated `version`.
- **ViaVersion / ViaProxy** lets one bot build span many server versions: point the bot at ViaProxy, which translates between the bot's native protocol and the target server's. This is how MC 1.8 → 1.21+ is covered without a bot rebuild.
- The driver pins a **support matrix** (target descriptor `mcVersionRange: "1.8 .. 1.21.x"`) and, on `session.create`, fails fast if minecraft-data lacks the requested version — surfaced to the runner as the skip reason `NO_COMPATIBLE_DRIVER` (with the unmet MC version in `unmet[]`).
- **testId** reading is version-aware: pre-1.20.5 reads the NBT key `mctp:testId`; 1.20.5+ reads the `mc-test:test_id` data component. The driver isolates this in one `readTestId(item, version)` helper.

### 1.4 Build / runtime requirements

- Node.js 18+; `npm i` in `/packages/driver-headless` (deps: `mineflayer`, `minecraft-data`, `prismarine-*`, `ws`).
- Optional: a running **ViaProxy** jar (Java 17+) when crossing versions; the runner can auto-launch it (see `mc-test.yml` `viaProxy:` block).
- No display, no GPU, no Xvfb. Runs in the smallest CI container.
- Target server must allow `online-mode=false`.

### 1.5 Known limits / what it CANNOT do

- **No client Screens** (`clientScreens=false`): cannot test any mod GUI that renders on the client (e.g. a Fabric mod's custom config screen). Negotiation skips this driver for such tests.
- **No key events / no real screenshots** (`pressKey`, `screenshot`, `rendering` = false).
- **Only server-driven container GUIs**: works great for chest-menu plugins (the canonical regions GUI **if** it is a chest menu), but a region plugin that draws its menu client-side is invisible.
- **World-truth is second-hand**: authoritative blocks/entities require the paired server agent; the bot's own view is partial and chunk-load-dependent.

### 1.6 Canonical regions example (headless path)

For a **chest-menu** regions plugin:
1. `world.runCommand("or")` → server opens a chest window.
2. `screen.waitForScreen({ kind: "container" })` (or poll `screen.get`).
3. `screen.clickElement({ label: "Regions" })` → resolves to the slot whose item display name is "Regions"; `bot.clickWindow`.
4. `screen.clickElement({ testId: "regions:entry:TestRegion" })` (or `{ label: "TestRegion" }`).
5. `world.waitForChat()` → assert a line `plain` contains `"Region loaded"` (assertion runs in the runner, not the bot).
6. Paired `server-bukkit`: `truth.assertPluginState({ query: "regions.exists", args: { name: "TestRegion" }, expect: { equals: true } })` → `{ ok: true, query: "regions.exists", value: true, matched: true, valueJson: "true" }`.

---

## 2. Driver: In-process client mod (`driver-inprocess` + `client-*` agents)

**Adapter package:** `/packages/driver-inprocess` (TypeScript) — speaks MCTP to the runner, forwards primitives to the in-game agent.
**Agents:** `/agents/client-fabric`, `/agents/client-forge`, `/agents/client-neoforge` (thin loader shims) over `/agents/core` (shared Java core).
**Kind:** `inprocess-client`.
**This is the ONLY driver that can see real client-rendered mod Screens.**

> **M5 status note (Forge/NeoForge shims).** `/agents/client-forge` (Forge, MCP-SRG / official mappings) and `/agents/client-neoforge` (NeoForge, Mojmap mappings) are now **scaffolded (M5; acceptance-only Loom/ForgeGradle/NeoGradle build)** — thin shims over `/agents/core` (like `/agents/client-fabric` from M4), with every obfuscation-mapped `net.minecraft.*` symbol quarantined to `mappings/Names.java` per §2.3, and registered in the runner (`KNOWN_CLIENT_AGENTS`). Their build-artifacts are **`agent-client-forge.jar`** and **`agent-client-neoforge.jar`**. The real rendered-client + Loom/ForgeGradle/NeoGradle mod builds remain **acceptance-only** in this repo's CI.

A **tiny dumb mod** runs inside the **real Minecraft client**. It embeds an MCTP **WebSocket server** (from `/agents/core`) and exposes primitives that reach into the client's screen/widget tree, keyboard, and framebuffer. The `driver-inprocess` adapter is a thin TS shim: most calls are forwarded 1:1 to the agent; the adapter exists so the runner only ever talks "north-side" MCTP and so reconnect/handshake policy lives in TS.

> **M4 status note (2026-06-15).** As of **M4** the in-process driver landed: `/packages/driver-inprocess` (the runner-side adapter that **launches and babysits the rendered client**, selects the display backend via `Display.ts` — `xvfb` on Linux CI / `desktop` otherwise — and **scrapes the client agent's MCTP port from the client log** line `MCTP listening on :PORT`) and `/agents/client-fabric` (the first client agent). Per the mapping discipline (§2.3), the loader-neutral `screen.*`/client `world.*` logic lives in **`/agents/core`** behind the `ClientBridge` **interface** (testable with no Minecraft), and `/agents/client-fabric` is a **thin shim** = the `ClientModInitializer` entrypoint + `mappings/Names.java` (the only Yarn-taxed file, which implements `ClientBridge`) + `fabric.mod.json`. The build-artifact name is **`agent-client-fabric-<mc>.jar`** (the `agent-<variant>-<mc>.jar` convention, `ENVIRONMENTS.md` §2.4). The runner registers `inprocess` as a selectable driver (cost 3, `agent.kind: clientMod`) and advertises exactly the §2.1 set. The `screen.*` conformance, the inprocess-vs-headless mixed selection, the screen-verb `anyOf` gating, and the combined client+server session are proven with **no boot** (`/agents/core` `ScreenConformanceTest` + the runner M4 tests).

> **F3 update (2026-06-16) — the launch path is real, the jars build.** `FINALIZATION.md` F3 replaced the earlier "acceptance-only / fictional CLI" launch sketch with a **real launcher** (see §2.4) and **built jars**. `/packages/driver-inprocess` now provisions and launches a real client end-to-end: **`ClientProvisioner.ts`** resolves the Mojang version manifest → version JSON → downloads the client jar + libraries + (optionally) the asset bundle, fetches the Fabric loader profile (meta.fabricmc.net) → loader libraries, extracts the LWJGL natives via a dependency-free ZIP reader, and stages a per-instance `gameDir/mods/` with the SUT mod(s) + the client agent jar (a content-addressed cache is shared across runs); **`ClientLauncher.ts`** (pure) builds a real `java -Djava.library.path=<natives> -cp <all jars> net.fabricmc.loader.impl.launch.knot.KnotClient` offline invocation (username `Tester`, zero UUID, `--accessToken 0` — no Microsoft); **`Display.ts`** adds a real `startDisplay` lifecycle (reuse an ambient `DISPLAY`, else spawn a managed Xvfb learned via `-displayfd`; desktop is a no-op); and **`InProcessDriver.start()`** wires start display → provision client → build launch → spawn → scrape `MCTP listening on :PORT` from the client log → return the ws url, with `stop()` tearing down client then display. The JVM jars now **build via Loom 1.7.4** (Gradle 8.10.2, JDK 21): the regions **mod** → **`openregions.jar`** and `/agents/client-fabric` → **`agent-client-fabric.jar`** (shaded `/agents/core` + Java-WebSocket as jar-in-jar), with the per-version Yarn mapping fixes confined to `mappings/Names.java` (`ConnectScreen` → `net.minecraft.client.gui.screen.multiplayer` at 1.20.4+; `NativeImage.writeTo(OutputStream)` round-trips through a temp `Path`) — the import-scan gate still passes. The launch path was **verified on a real Windows/Java-21 machine** (resolved MC 1.21.1, Fabric loader 0.19.3, downloaded the client jar + 54 libraries, extracted 8 LWJGL native bundles, staged the two jars, built a real 55-jar-classpath `KnotClient` command; asset bundle skipped via `downloadAssets:false`). The **honest-skip** half is verified for real (`clientScreens` on headless Paper → JUnit `<skipped>` `NO_COMPATIBLE_DRIVER unmet:[clientScreens]`); the **rendered GREEN** (a real frame + the GUI click on a live client) is **implemented + CI-gated** by the `e2e.yml` **`fabric-rendered-client`** lane (xvfb + `libgl1-mesa-dri` + `mesa-utils`, Loom-builds the jars, runs under `xvfb-run`) / `Dockerfile.rendered` (pinned `eclipse-temurin:21-jdk` + Mesa llvmpipe, `LIBGL_ALWAYS_SOFTWARE=1`), **not observed on a GPU-less local box** (`ROADMAP.md` §5.4).

### 2.1 Capability set (advertised)

```jsonc
{
  "driverKind": "inprocess-client",
  "capabilities": {
    "chat": true,
    "command": true,
    "containerGui": true,     // client also renders container screens
    "clientScreens": true,    // THE differentiator
    "typeText": true,
    "pressKey": true,
    "testIdTags": true,       // reads widget testId (TestIdHolder / WIDGET_ID)
    "screenshot": true,
    "rendering": true,
    "worldTruth": "client-side", // client-known blocks/entities only (not authoritative)
    "pluginState": false,     // CANNOT — pair with a server agent for plugin probes
    "fixtures": false,
    "fakePlayers": false,
    "pixelOnly": false        // driver-local marker (non-canonical); always false here
  }
}
```

### 2.2 How it implements each MCTP primitive

The shared core dispatches each MCTP method to a **loader-specific mapping** of Minecraft client internals. Names below use Yarn (Fabric) for concreteness; Forge/NeoForge use MCP/Mojmap equivalents resolved at compile time (see §2.3).

| MCTP method | Implementation in client agent |
|-------------|-------------------------------|
| `session.create`/`session.describe`/`session.close`/`session.ping` | Native in `/agents/core`; the agent's WS server accepts the runner's session. `session.create` validates required caps against this loader build. |
| `world.join`/`world.leave` | Connect/disconnect the client to the target server (`ConnectScreen.connect(...)` / disconnect). |
| `screen.get` | Read `MinecraftClient.getInstance().currentScreen`; return `{ screenId: screen.getClass().getName(), title: screen.getTitle().getString(), kind: classifyScreen(screen), size: {w,h} }`. `kind` ∈ the canonical `containerGui｜clientScreen｜hud｜none` (PROTOCOL.md §7.2; the shipped M4 client agent emits `clientScreen`). |
| `screen.listElements` | Walk the screen's children: `((Screen)screen).children()` → for each `ClickableWidget`/`Element`, build `Element { ref, label: widget.getMessage().getString(), role: roleOf(widget), bounds: {x,y,w,h}, enabled: widget.active, testId: readWidgetTestId(widget) }`. For container screens, also enumerate `HandledScreen` slots. With a selector, filters in-driver: `label`→`getMessage()` equality; `textContains`→substring; `role`→widget class mapping (`ButtonWidget`→`button`, `TextFieldWidget`→`input`, …); `testId`→an interface `TestIdHolder` our cooperating mods implement (or a `WIDGET_ID` synthetic injected via mixin for SUTs we instrument); `loreContains`/`itemType`→slot tooltips/stacks on `HandledScreen`. |
| `screen.clickElement` | Resolve to one widget; invoke its click path on the client thread: `widget.onClick(mx,my)` / `widget.mouseClicked(cx,cy,0)` at the widget center, or for slots `((HandledScreenAccessor)screen).callOnMouseClick(slot, slot.id, 0, SlotActionType.PICKUP)`. All UI mutation is scheduled on the render thread via `client.execute(() -> ...)`. |
| `screen.typeText` | Focus the target `TextFieldWidget` and call `field.setText` / replay `charTyped`/`keyPressed` per char so SUT change-listeners fire. Defaults to the focused widget if no selector. |
| `screen.pressKey` | Translate the key name to a GLFW keycode and dispatch through the current screen's `keyPressed(key, scancode, mods)` (e.g. `ESCAPE`→`GLFW_KEY_ESCAPE`). |
| `screen.screenshot` | `ScreenshotRecorder.takeScreenshot(...)` into a `NativeImage`, encode PNG, return base64. Requires `rendering` (a real framebuffer). |
| `screen.close` | `client.execute(() -> client.setScreen(null))` (or invoke the screen's close handler) to dismiss the current screen. |
| `world.sendChat` | `client.player.networkHandler.sendChatMessage(msg)`; for opening chat UI, `screen.pressKey("T")` then `screen.typeText`. |
| `world.runCommand` | `client.player.networkHandler.sendCommand(cmd)` (slash command, no leading `/`). |
| `world.waitForChat` | Tap `ChatHud` message history (mixin/accessor on `ChatHud.messages`); blocks for a matching line and emits `event.chat` with `raw` + `plain`. |
| `truth.getWorldBlock` | `client.world.getBlockState(new BlockPos(x,y,z))` → registry id + properties. **Client-known only** (loaded chunks around the player); advertised as `worldTruth:"client-side"`, not authoritative. |
| `truth.getEntities` | Iterate `client.world.getEntities()` with the query filter. Client-side view only. |
| `truth.assertPluginState` / `fixture.set` / `fixture.reset` / `player.spawnFake` / `player.despawnFake` | **Not supported** — a client mod cannot author server plugin state. Returns `METHOD_NOT_SUPPORTED`. Pair with `server-bukkit`/`server-fabric`. |

### 2.3 Version strategy — shared core + thin loader shims + the mappings tax

- **One shared core** (`/agents/core`) holds the MCTP server, JSON-RPC dispatch, selector-free primitive logic, and a `ClientBridge` **interface**. Zero Minecraft imports leak version specifics into the wire layer.
- **Thin per-loader shims** (`client-fabric`/`client-forge`/`client-neoforge`) implement `ClientBridge` against that loader's client API and entrypoint (`ClientModInitializer` for Fabric; `@Mod` + client event bus for Forge/NeoForge).
- **The obfuscation/mappings tax is isolated here.** Only the shim recompiles per (loader × MC version). Fabric uses **Yarn**, Forge legacy uses **MCP/SRG**, NeoForge/modern uses **Mojmap (official mappings)**. Mixins/Access Wideners that reach private client fields (`ChatHud.messages`, `HandledScreen` slot click) are declared per mapping set. The matrix builds artifacts under the canonical `agent-<variant>-<mc>.jar` convention (`ENVIRONMENTS.md` §2.4): `agent-client-fabric-1.20.1.jar`, `agent-client-neoforge-1.21.jar`, etc.
- Generating N artifacts is a build-matrix concern (Gradle `loom`/`neogradle` source sets), **not** a code-duplication concern: the core is compiled once; only the shim's mapping layer differs.

### 2.4 Build / runtime requirements

- JDK 17 (MC 1.17+) / JDK 8 (legacy ≤1.16) per target; Gradle with Fabric Loom / ForgeGradle / NeoGradle. As of **F3** the Fabric jars **build** (Loom 1.7.4, Gradle 8.10.2, JDK 21): the regions mod → **`openregions.jar`**, `/agents/client-fabric` → **`agent-client-fabric.jar`** (shaded `/agents/core` + Java-WebSocket as jar-in-jar). The per-version Yarn mappings stay quarantined in `mappings/Names.java` (§2.3).
- A **real Minecraft client** launched with the SUT mod **and** the matching `client-*` agent jar in `mods/`. `/packages/driver-inprocess` builds the launch itself (no external launcher): **`ClientProvisioner.ts`** resolves the Mojang version manifest → version JSON → downloads the client jar + libraries + (optional) asset bundle and the Fabric loader profile (meta.fabricmc.net) → loader libraries, extracts the LWJGL natives via a dependency-free ZIP reader, and stages a per-instance `gameDir/mods/` (SUT mod + client agent) from a content-addressed cache; **`ClientLauncher.ts`** emits a real `java -Djava.library.path=<natives> -cp <all jars> net.fabricmc.loader.impl.launch.knot.KnotClient` offline invocation (username `Tester`, zero UUID, `--accessToken 0`, no Microsoft auth).
- **Rendering surface**: a GPU or **Xvfb** (Linux headless) or a desktop CI runner (Windows/macOS). `Display.ts` selects the backend (Linux→`xvfb` with `LIBGL_ALWAYS_SOFTWARE=1` for Mesa/llvmpipe, win32/macOS→`desktop`, explicit pref wins) and runs a real `startDisplay` lifecycle (reuse an ambient `DISPLAY`, else spawn a managed Xvfb learned via `-displayfd`; desktop is a no-op). `Dockerfile.rendered` (pinned `eclipse-temurin:21-jdk` + Node + Xvfb + Mesa) is the reproducible headless-rendering image.
- The agent opens its MCTP WS on a per-instance port and logs **`MCTP listening on :PORT`** to the client log; `InProcessDriver.start()` **scrapes** that line to learn the port and dials `ws://<bindHost>:PORT`. `start()` wires display → provision → launch → spawn → scrape → ws url; `stop()` tears down client then display.

### 2.5 Known limits / what it CANNOT do

- **No authoritative server state**: `pluginState`/`fixtures`/`fakePlayers` = not capable; `worldTruth` is client-side only. Real assertions about "does region TestRegion exist on the server" require a paired server agent.
- **Heaviest driver**: needs a rendered client + display; slowest to boot; least parallel (one client per instance). Reserve for true client-GUI tests.
- **testId for non-cooperating mods** requires a mixin to inject ids; without instrumentation, selection falls back to `label`/`textContains`/`role`.
- **Mapping drift**: a brand-new MC snapshot needs updated Yarn/Mojmap before the shim builds — the per-version tax.

### 2.6 Canonical regions example (in-process path)

For a **client-rendered** regions mod (the case headless cannot do):
1. `world.runCommand("or")` → mod opens its custom `RegionsScreen`.
2. `screen.get()` → `kind: "menu"`, title "Open Regions".
3. `screen.clickElement({ label: "Regions" })` → resolves a `ButtonWidget` by `getMessage()`; click dispatched on render thread.
4. `screen.clickElement({ testId: "regions:entry:TestRegion" })` (mod implements `TestIdHolder`).
5. `screen.screenshot()` on failure → PNG artifact.
6. `world.waitForChat()` → assert contains `"Region loaded"`. Server-truth half of the assertion runs on the paired `server-fabric` agent.

---

## 3. Driver: Server-side agent (`server-bukkit` / `server-fabric`)

**Agents:** `/agents/server-bukkit` (Bukkit/Paper plugin) and `/agents/server-fabric` (server-mod variant) over `/agents/core`.
**`driverKind`:** `server` · **MCTP `agent.kind`:** `serverPlugin` (server mod variant: `serverMod`) — the value returned in the `session.create` handshake (`PROTOCOL.md` §4.3).
**Owns authoritative world-truth, plugin/mod-state assertions, fixtures, and fake players.**

This agent runs **inside the server JVM**. It is the source of ground truth: it reads the real world, queries SUT plugin state through registered probes, mutates state for setup, and spawns fake players. It does **no** client-side UI work — it has no screen. It is almost always **paired** with driver 1 or driver 2 (which drive the UI) to complete an assertion. As of **M3** the Bukkit plugin agent (`/agents/server-bukkit`) is the first server agent built; it is implemented against the **stable Bukkit/Paper API only** (no NMS / Mojang-mapped symbols), so it needs no per-version remap.

> **M5 status note (server-mod variant).** `/agents/server-fabric` (Fabric/NeoForge SERVER-mod truth agent, MCTP `agent.kind: serverMod`) is now **scaffolded (M5; acceptance-only Loom/ForgeGradle/NeoGradle build)** — a thin shim over `/agents/core` with every obfuscation-mapped `net.minecraft.*` symbol quarantined to `mappings/Names.java` (§3.3), advertising `worldTruth`/`pluginState`/`fixtures`/`fakePlayers`/`chat`/`testIdTags`, and registered in the runner (`KNOWN_AGENTS`). Its build-artifact is **`agent-server-fabric.jar`**. The real Fabric/Quilt server-mod build remains **acceptance-only** in this repo's CI.

### 3.1 Capability set (advertised)

`server-bukkit` advertises exactly these six canonical capability keys (`PROTOCOL.md` §6.1; the `serverPlugin`/`serverMod` bundle in §6.2). `command` is **not** in the advertised set — the agent runs console commands internally for fixtures/fake players, but does not advertise `command` as a UI-actor capability (the bot/client driver owns `world.runCommand`).

```jsonc
{
  "driverKind": "server",     // runner-side driver id (cost order, §5)
  "agentKind": "serverPlugin",// MCTP handshake agent.kind (PROTOCOL.md §4.3)
  "capabilities": {
    "worldTruth": true,       // authoritative blocks/entities
    "pluginState": true,      // truth.assertPluginState via registered probes
    "fixtures": true,         // fixture.set / fixture.reset
    "fakePlayers": true,      // player.spawnFake / despawnFake (Carpet-backed)
    "chat": true,             // can inject/observe server chat
    "testIdTags": true,       // SUTs we control emit testId carriers the agent honors
    "containerGui": false,    // no client; cannot click a rendered GUI
    "clientScreens": false,
    "command": false,         // UI command-actor is the bot/client; agent runs console internally
    "typeText": false,
    "pressKey": false,
    "screenshot": false,
    "rendering": false,
    "pixelOnly": false        // driver-local marker (non-canonical); always false here
  },
  "capabilityDetails": {
    "worldTruth": { "radiusLimit": 64 },     // max truth.getEntities radius (PROTOCOL.md §6.3)
    "fakePlayers": { "backend": "carpet" }    // Carpet-style /player command backend
  }
}
```

### 3.2 How it implements each MCTP primitive

| MCTP method | Implementation in server agent |
|-------------|-------------------------------|
| `session.create`/`session.describe`/`session.close`/`session.ping` | Native in `/agents/core`, embedded in the plugin/mod's `onEnable`/`onInitialize`. WS server bound to a per-instance port. |
| `world.join`/`world.leave` | Marks the agent's logical session against the running world; no client connection of its own (the agent already lives in the server JVM). |
| `truth.getWorldBlock` | **Bukkit:** `world.getBlockAt(x,y,z)` → `{ type: block.getType().getKey() (lowercase `namespace:path`), properties: blockData, nbtJson?, biome? }`. **Fabric server:** `serverWorld.getBlockState(pos)`. Runs on the main server thread via the scheduler. Out-of-range/unloaded → `WORLD_NOT_READY`. Field shape per `PROTOCOL.md` §7.3 `truth.getWorldBlock`. |
| `truth.getEntities` | **Bukkit:** `world.getNearbyEntities(loc, r, r, r)` (sphere) or `world.getEntities()` filtered by type → `{ ok, count, entities:[{ id, uuid, type, name?, position:{x,y,z}, tags?[], customNameRaw? }] }`. **Fabric:** `serverWorld.getEntitiesByType(...)`. `radius` > granted `worldTruth.radiusLimit` → `-32602 invalidParams`. Field shape per `PROTOCOL.md` §7.3. |
| `truth.assertPluginState` | Resolves a **registered probe** by `query` name (params `{ plugin?, query, args?, expect? }`). Preferred path: the SUT registers an `McTestStateProvider` via the Bukkit `ServicesManager` (see §3.2.1); a reflective/expression fallback (`regions.exists(name)`, `config.get(path)`, `perms.has`) covers SUTs without the SPI. Evaluates the optional `expect` predicate (`equals｜notEquals｜contains｜gt｜gte｜lt｜lte｜exists`) over the value and returns `{ ok, query, value, matched, valueJson }` (`matched:null` if no `expect`). Unknown query / evaluation failure → `ASSERT_FAILED`. The agent returns facts; the **runner** owns the verdict. Field shape per `PROTOCOL.md` §7.5. |
| `fixture.set` | Applies a **named fixture** (params `{ fixture, args? }`): built-ins `gamerule`, `time`, `weather`, `inventory` (give/clear), `permissions` (grant/revoke). Any fixture a registered `McTestFixtureProvider#supports` (e.g. `regions.createRegion` from the SUT) is delegated to that provider. Records an undo per applied fixture. Returns `{ ok, fixture, applied:true, handle, result? }`. Unknown/failed → `FIXTURE_FAILED`; bad args → `-32602`. Field shape per `PROTOCOL.md` §7.5. |
| `fixture.reset` | Reverts applied fixtures (params `{ snapshot?, world?, fixtureId? }`; no arg ⇒ revert all session fixtures), restoring the pristine world/plugin baseline. Returns `{ ok, restored?, tookMs? }`. |
| `player.spawnFake` | **Bukkit:** Carpet-style console command `/player <name> spawn at <x> <y> <z>` (`Bukkit.dispatchCommand(consoleSender, …)`); params `{ name, at?, gameMode? }` → `{ ok, name, uuid, handle }`. `capabilityDetails.fakePlayers.backend = "carpet"`. The handle is usable as an actor for server-side actions. |
| `player.despawnFake` | Despawns by `handle` (or `name`): params `{ handle?, name? }` → `{ ok, despawned }`. Unknown → `-32602`. The agent also despawns any remaining fake players on `session.close`. |
| `world.sendChat` | Broadcasts/injects chat; can also `player.performCommand` for a named (fake) player. |
| `world.runCommand` | Runs a **console command** (`Bukkit.dispatchCommand(consoleSender, cmd)`) or a named (fake) player's command. |
| `world.waitForChat` | Subscribes to server chat events (`AsyncPlayerChatEvent` / Fabric `ServerMessageEvents`) and broadcast log; blocks for a matching line and emits `event.chat`. |
| `screen.listElements`/`screen.get`/`screen.clickElement`/`screen.typeText`/`screen.pressKey`/`screen.screenshot`/`screen.close`/`screen.waitForScreen` | **Not supported** — the server has no client screen to introspect or click. All return `METHOD_NOT_SUPPORTED`. (UI is the bot's or client mod's job.) |

> Note on `containerGui`: even though container GUIs are *server-driven*, **clicking** one requires a connected client/bot to receive the open-window packet and send click packets. The server agent can *open* an inventory for a (fake) player but cannot itself perform the semantic `screen.clickElement`. So `containerGui` is advertised **false** here; the bot/client driver does the clicking, the server agent does the truth.

> Per-session resources: the agent **tracks** every fixture it applies and every fake player it spawns against the originating session, and **releases** them on `session.close` (revert fixtures, despawn fake players) — `PROTOCOL.md` §4.4 / §7.5.

### 3.2.1 SUT extension SPIs (`McTestStateProvider` / `McTestFixtureProvider`)

Both SPIs are **pure Java interfaces** shipped in `/agents/core` (no Bukkit types), so a SUT can implement them without depending on the agent's loader. The canonical `/examples/regions` plugin registers both to make the regions assertion resolve from **real** plugin state.

| SPI (in `/agents/core`) | Backs | Shape | How the SUT registers it |
|---|---|---|---|
| `McTestStateProvider` | `truth.assertPluginState` (cap `pluginState`) | `Object query(String query, Map<String,Object> args) throws Exception` | `getServer().getServicesManager().register(McTestStateProvider.class, provider, plugin, ServicePriority.Normal)` |
| `McTestFixtureProvider` | `fixture.set` / `fixture.reset` (cap `fixtures`) | `boolean supports(String fixture)` · `Object apply(String fixture, Map<String,Object> args) throws Exception` · `void undo(String handle) throws Exception` | registered the same way via the Bukkit `ServicesManager` |

The agent resolves a `query`/`fixture` to a provider through the `ServicesManager` first; only if no provider answers does it fall back to the reflective/expression path (for `assertPluginState`) or fail with `FIXTURE_FAILED` (for an unknown fixture). For the regions example, `query:"regions.exists"` with `args:{name:"TestRegion"}` returns a real boolean from the plugin's region store, and `fixture:"regions.createRegion"` mutates that store and registers an undo. The classloading discipline (SUT compiles the SPI at *provided* scope and `softdepend`s the agent so both share one class) is owned by `/examples/regions` — see `ROADMAP.md` §4.3.

### 3.3 Version strategy — Bukkit API stability + packetevents

- **Bukkit/Paper API is broadly stable across versions**, so `server-bukkit` largely compiles once against a base API and runs on many server versions; only genuinely version-divergent calls (NMS, new registries) are isolated behind a small `ServerBridge` with version-guarded branches.
- **`packetevents`** provides a **cross-version, cross-platform** packet abstraction — the basis for portable behaviors (opening windows for fake players, observing packets) without per-version NMS. It also enables a **proxy-observer** mode where the agent watches packets between client and server.
- **`server-fabric`** (server-mod variant) pays a mappings tax like the client mod (Mojmap/Yarn), isolated in `/agents/core`'s `ServerBridge` Fabric impl; it covers Fabric/Quilt servers where no Bukkit API exists.
- **Carpet** supplies fake players across the versions it supports; the agent feature-detects Carpet and advertises `fakePlayers` accordingly (false if absent).
- SUT-specific probes/fixtures are registered by a tiny **SUT shim** the test author ships, keeping the agent dumb and the regions-specific knowledge (e.g. which region API to call) outside the core.

### 3.4 Build / runtime requirements

- JDK matching the server (17 for modern Paper/Fabric; 8 for legacy). Gradle (`/agents` is a `mc-test-agents` Gradle build: `:core` + `:server-bukkit`). `server-bukkit` is a **fat plugin jar** that bundles `/agents/core` + Java-WebSocket (paper-api and Gson are `compileOnly` — Paper provides them at runtime); it is dropped in `plugins/`. `server-fabric` builds a server mod jar for `mods/`.
- The plugin's `plugin.yml` declares `name: mc-test-agent`, `main: io.mctest.agent.bukkit.McTestAgentPlugin`. The MCTP port is read from `plugins/mc-test-agent/config.yml` (`port:`), and on start the agent logs **`MCTP listening on :PORT`** (the line the runner scrapes to learn the port).
- **Build-artifact naming.** The fat jar produced by the Gradle build is **`mc-test-agent-bukkit.jar`**. When dropped into the provisioner via the `agentResolver`, it is resolved/installed under the per-version name **`agent-server-bukkit-<mc>.jar`** (e.g. `agent-server-bukkit-1.20.4.jar`) — the canonical `agent-<variant>-<mc>.jar` convention (`ENVIRONMENTS.md` §2.4). The Bukkit agent needs no per-version remap, so the same jar serves every `mc` the Bukkit API supports.
- Optional **Carpet** mod/plugin for fake players; optional **packetevents** (shaded).
- Runs headless inside the server container — no display.
- The runner provisions it Testcontainers-style: auto-download Paper/Fabric, copy a **pristine world snapshot**, install SUT + this agent, boot `online-mode=false` on a unique port.

> **Multi-connection (driver + agent) session.** The server agent listens on its **own** MCTP port — distinct from the game port and from any UI driver. A test that needs both a UI surface and server truth runs over **two MCTP connections** unified behind one logical session: the runner fans GUI/chat steps to the UI driver connection and `truth.*`/`fixture.*`/`player.*` steps to this agent connection. The agent advertises its caps independently; the runner reasons about the **union** of advertised caps (`CAPABILITIES.md` §4 co-driver rule, `PROTOCOL.md` §11). When no server agent is co-selected, `pluginState`/`worldTruth`/`fixtures`/`fakePlayers` steps **skip honestly** with `unmet:[…]` rather than pass.

### 3.5 Known limits / what it CANNOT do

- **No UI at all**: cannot click buttons, read client Screens, or screenshot. Always pair with a UI driver (1 or 2) for end-to-end GUI flows.
- **`truth.assertPluginState` needs a probe**: if the SUT ships no probe and none is registered, the assertion fails with `ASSERT_FAILED` — the framework cannot magically know plugin internals.
- **Fake players approximate clients**: Carpet bots don't render client GUIs; they cannot validate client-side mod screens.
- **NMS edge cases**: deeply version-specific server internals still require version-guarded code in `ServerBridge`.

### 3.6 Canonical regions example (server path)

The server agent provides **setup + the world-truth half** of the canonical assertion:
1. `fixture.set({ fixture: "regions.createRegion", args: { name: "TestRegion" } })` (optional) — pre-create the region so `/or` has data; `→ { ok, fixture, applied:true, handle, result:{ regionId:"TestRegion" } }`.
2. (UI driver runs `/or` → click "Regions" → click "TestRegion".)
3. `truth.assertPluginState({ query: "regions.exists", args: { name: "TestRegion" }, expect: { equals: true } })` → `{ ok: true, query: "regions.exists", value: true, matched: true, valueJson: "true" }`. The runner asserts `matched === true`.
4. Optionally `truth.getWorldBlock` / `truth.getEntities` to verify region-side effects (e.g. a marker block placed at the region center).

---

## 4. Driver: Pixel / OCR (`driver-pixel`)

**Package:** `/packages/driver-pixel` (TypeScript).
**Kind:** `pixel`.
**Universal last resort. Brittle. Use only when no structural driver fits** (e.g. a closed-source client we cannot mod, or a rendering-only assertion).

This driver treats the screen as **pixels**: it captures a framebuffer (from a rendered client it does not instrument), runs **OCR** (Tesseract) and **template matching** (OpenCV) to locate text/elements, and dispatches **OS-level mouse/keyboard** events. It resolves semantic selectors **visually** — `label`/`textContains` via OCR, `itemType`/`role` via template images. It has **no structural knowledge**: no widget tree, no NBT, no `testId`.

> **Status (M5).** The package `/packages/driver-pixel` (`@mc-test/driver-pixel`) now exists as a **selectable stub** registered in the runner `DriverRegistry` at **cost 4** (the last resort — `server < headless < inprocess < pixel`), MCTP `agent.kind: pixelOcr`. The implemented stub advertises the **boolean** capability set `chat`, `command`, `containerGui`, `clientScreens`, `screenshot`, `rendering`, `typeText`, `pressKey` plus the advisory `brittle: true` descriptor (and all loaders + `mcVersionRange: ">=1.8"`); it does **not** advertise `testIdTags`, `worldTruth`, `pluginState`, `fixtures`, or `fakePlayers`. The richer §4.1 model — `"visual"` string-valued capabilities and the `pixelOnly` negotiation-pin — remains the **aspirational** form. The **OCR/template + OS-input backend is NOT implemented**: the stub is registered purely for capability negotiation, and `start()` fails honestly (`PixelDriverNotImplementedError`); selection never launches it (it is chosen only when nothing cheaper fits, or `driver: pixel` is pinned). `brittle` is a new **advisory-only quality descriptor** on the protocol `Capabilities` object — deliberately **excluded** from the canonical `CAPABILITY_KEYS` (which stays the 13 boolean keys), so it is **not** a matchable capability (like the `loader`/`mcVersionRange` target descriptors); a test cannot "require" `brittle`. The runner reads it solely to emit a **loud report note** (console + a JUnit `<property name="brittle" value="true"/>`) when a brittle driver is selected.

### 4.1 Capability set (advertised)

```jsonc
{
  "driverKind": "pixel",
  "capabilities": {
    "screenshot": true,
    "rendering": true,        // there is a real framebuffer to capture
    "pixelOnly": true,        // driver-local marker (non-canonical): selectors resolve via OCR/template ONLY
    "clientScreens": "visual",// can *see* client screens, but only as pixels (no structure)
    "containerGui": "visual",
    "typeText": true,         // OS-level typing into whatever has focus
    "pressKey": true,         // OS-level key events
    "testIdTags": false,      // CANNOT read tags — no structure
    "chat": "visual",         // can read chat via OCR (lossy)
    "command": "visual",      // can type slash commands via OS keys (lossy echo)
    "worldTruth": false,      // CANNOT
    "pluginState": false,     // CANNOT
    "fixtures": false,
    "fakePlayers": false
  }
}
```

> `"visual"` capabilities are advertised at **lower priority** than structural equivalents. Negotiation only selects pixel for a capability when **no structural driver** offers it (or the test explicitly requests `pixelOnly`). This keeps the brittle path as the documented last resort.

### 4.2 How it implements each MCTP primitive

| MCTP method | Implementation in driver-pixel |
|-------------|--------------------------------|
| `session.create`/`session.describe`/`session.close`/`session.ping` | Native TS. `session.create` attaches to a capture source: a window handle, an Xvfb display (`:99`), or a video/RTMP feed; and to an input backend (`@nut-tree/nut-js` / `robotjs` / `xdotool`). |
| `world.join`/`world.leave` | Best-effort: drive the stock client's multiplayer connect/disconnect via OCR + OS input (locate and click the server entry / Disconnect button). |
| `screen.screenshot` | Grab the framebuffer (nut-js `screen.grab` / `import` / `scrot`), return PNG base64. The one primitive it does best. |
| `screen.get` | Heuristic: classify the captured frame against template anchors → `{ screenId: matchedTemplateName, title: ocr(titleRegion), kind: "visual", size: frameSize }`. Low confidence → `kind: "unknown"`. |
| `screen.listElements` | Run OCR over the frame → text boxes; run template matching for known icons → element boxes. Build `Element[]` `{ ref, label: ocrText, role: templateRole?, bounds: box, testId: null }`. Best-effort, confidence-scored. With a selector, resolved **visually**: `label`/`textContains`→OCR string match (fuzzy, normalized); `itemType`/`role`→template image match; `nth`/`index`→order boxes top-left→bottom-right; `within`→restrict to a sub-rectangle from a parent template; `loreContains`→OCR a hover-tooltip after moving the cursor over the box; `testId`→**ignored** (cannot read tags). |
| `screen.clickElement` | Resolve to one box, move OS cursor to its **center** and click (`nut-js mouse.click`). The only driver that legitimately ends at pixel coordinates — but the **test author still wrote a selector**, the driver did the coordinate resolution. |
| `screen.typeText` | Type via OS keyboard events into whatever has focus (`keyboard.type`). |
| `screen.pressKey` | OS-level key event (`keyboard.pressKey(Key.Escape)` etc.). |
| `screen.close` | `screen.pressKey("ESCAPE")` (or click a template-matched close button) to dismiss the current screen. |
| `world.sendChat` | `screen.pressKey("T")` → `screen.typeText(line)` → `screen.pressKey("ENTER")`. |
| `world.runCommand` | `screen.pressKey("T")` → `screen.typeText("/" + cmd)` → `screen.pressKey("ENTER")`. |
| `world.waitForChat` | OCR the chat HUD region; return best-effort `plain` lines (no reliable `raw`); blocks for a fuzzy match. |
| `truth.getWorldBlock`/`truth.getEntities`/`truth.assertPluginState`/`fixture.set`/`fixture.reset`/`player.spawnFake`/`player.despawnFake` | **Not supported** — pixels carry no world/plugin truth. All return `METHOD_NOT_SUPPORTED`. Pair with a server agent if truth is needed. |

### 4.3 Version strategy — OCR / template packs

- **Version independence by construction**: pixels don't care about protocol or mappings. The per-version cost moves into **template image packs** and **OCR tuning** — a button/icon may be re-skinned between MC versions or resource packs, so the driver loads a `templatePack` keyed by `{ mcVersion, resourcePack, guiScale }`.
- OCR (Tesseract) is configured with Minecraft-font hints; `guiScale` and DPI are recorded per target so box coordinates are stable.
- New version support = capture a few reference frames and add/adjust templates; **no recompile**.

### 4.4 Build / runtime requirements

- Node 18+; `/packages/driver-pixel` deps: an OCR binding (`tesseract.js` or native Tesseract), `opencv4nodejs`/`@u4/opencv4nodejs` for templates, `@nut-tree/nut-js` (or `robotjs`/`xdotool`) for input, a capture lib.
- A **real rendered surface** to look at: a desktop CI runner or **Xvfb** + a running client (which may be the SUT's stock client, unmodified). Docker possible but input/capture backends are OS-sensitive.
- Template/OCR asset packs per `{version, resourcePack, guiScale}`.

### 4.5 Known limits / what it CANNOT do

- **Brittle**: breaks on resolution/`guiScale`/resource-pack/theme changes, animations, overlapping tooltips, and font anti-aliasing. Highest flake rate.
- **No structure**: ignores `testId`; cannot read NBT/lore reliably; `role` is guesswork from templates.
- **No truth**: `worldTruth`/`pluginState`/`fixtures`/`fakePlayers` impossible — pair with a server agent.
- **Slow & serial**: one OS desktop/display per instance; OCR per frame is expensive.
- **Last in negotiation**: selected only when nothing structural fits, or when a test explicitly sets `requires: [pixelOnly]`.

### 4.6 Canonical regions example (pixel path)

Only if the regions client is un-moddable (no in-process agent possible):
1. `world.runCommand("or")` (T → type `/or` → Enter).
2. `screen.screenshot()` + `screen.get()` to confirm a menu appeared (template anchor).
3. `screen.clickElement({ textContains: "Regions" })` → OCR finds the "Regions" box → click its center.
4. `screen.clickElement({ textContains: "TestRegion" })`.
5. `world.waitForChat()` (OCR) → fuzzy-assert "Region loaded".
6. Server-truth half still requires a paired `server-bukkit` (`truth.assertPluginState`), since pixels can't prove the region exists.

---

## 5. Capability negotiation across drivers (summary matrix)

`✓` = capable; `pair` = capable only when paired with the noted agent; `visual` = capable but OCR/pixel-only (lowest priority); `✗` = not capable (`METHOD_NOT_SUPPORTED`).

| Capability \ Driver | headless | inprocess-client | server | pixel |
|---------------------|:--------:|:----------------:|:------:|:-----:|
| `chat`              | ✓ | ✓ | ✓ | visual |
| `command`           | ✓ | ✓ | ✓ (console) | visual |
| `containerGui`      | ✓ | ✓ | ✗ | visual |
| `clientScreens`     | ✗ | ✓ | ✗ | visual |
| `typeText`          | ✓ (text inputs) | ✓ | ✗ | ✓ |
| `pressKey`          | ✗ | ✓ | ✗ | ✓ |
| `testIdTags`        | ✓ | ✓ | ✗ | ✗ |
| `screenshot`        | ✗ | ✓ | ✗ | ✓ |
| `rendering`         | ✗ | ✓ | ✗ | ✓ |
| `worldTruth`        | pair(server) | client-side | ✓ | ✗ |
| `pluginState`       | pair(server) | ✗ | ✓ | ✗ |
| `fixtures`          | pair(server) | ✗ | ✓ | ✗ |
| `fakePlayers`       | pair(server) | ✗ | ✓ | ✗ |

**Negotiation rule (runner):** for a test's `requires: [caps...]`, choose the **cheapest single driver** whose advertised caps ⊇ required caps; if a required cap is only `pair`-satisfiable, ensure the matrix target provisions the paired `server-*` agent and open a second MCTP session to it; if no combination satisfies, **skip the test** with reason `NO_COMPATIBLE_DRIVER` carrying `unmet: [missing caps]`. Default cost order: `headless < server < inprocess-client < pixel`. A test may pin `driver: <kind>` or `requires: [pixelOnly]` (the driver-local pixel marker) to override.

**Worked examples:**
- *Regions chest-menu plugin test* → `requires: [containerGui, command, pluginState]` → **headless** (UI + commands) **paired with server-bukkit** (pluginState). Cheap, CI-friendly.
- *Regions client-GUI mod test* → `requires: [clientScreens, command, pluginState]` → **inprocess-client** (UI) **paired with server-fabric** (pluginState) under Xvfb. Only path that works.
- *Closed client smoke test* → `requires: [pixelOnly, command]` → **pixel** (+ optional server pair). Last resort.

---

## Contract reference (canon recap — defined by PROTOCOL.md)

> These names are **defined by `PROTOCOL.md`** (the single source of truth for the MCTP wire contract). This section recaps the subset DRIVERS.md uses, for convenience only; on any discrepancy, `PROTOCOL.md` wins. Transport: JSON-RPC 2.0 over WebSocket; runner = client, driver/agent = server; `session.create` negotiates `protocolVersion` starting at `"1.0"`.

**MCTP method names (verbatim):**
`session.create`, `session.describe`, `session.close`, `session.ping`,
`world.join`, `world.leave`, `world.sendChat`, `world.runCommand`, `world.waitForChat`,
`screen.get`, `screen.listElements`, `screen.clickElement`, `screen.typeText`, `screen.pressKey`, `screen.screenshot`, `screen.waitForScreen`, `screen.close`,
`truth.getWorldBlock`, `truth.getEntities`, `truth.assertPluginState`,
`fixture.set`, `fixture.reset`, `player.spawnFake`, `player.despawnFake`.

**Notifications (server → client events):** `event.chat`, `event.screenChanged`, `event.log`, `event.disconnected`.

**Capability keys (flat, lowerCamelCase):**
`chat`, `command`, `containerGui`, `clientScreens`, `screenshot`, `rendering`, `worldTruth`, `pluginState`, `fixtures`, `fakePlayers`, `typeText`, `pressKey`, `testIdTags`.
Target descriptors: `loader` (enum), `mcVersionRange` (string).
Driver-local advertisements (NOT part of the canonical vocabulary): `pixelOnly` (pixel visual-resolution marker), `inventoryGridSnapshot` (headless debug grid), `worldViewBot` (headless partial entity view).

**Selector keys (ANDed):** `label`, `text`, `textContains`, `loreContains`, `itemType`, `role`, `index`, `nth`, `within`, `testId`.
**`role` enum:** `button`, `slot`, `label`, `input`, `tab`, `list`, `listItem`.

**`Element` fields (this doc's shape, using canon keys):** `ref`, `label`, `role`, `testId`, `itemType`, `lore`, `enabled`, `bounds`.
**`screen.get` fields (this doc's shape):** `screenId`, `title`, `kind`, `size`, `elementCount`. **`kind` enum (canonical, PROTOCOL.md §7.2):** `containerGui`, `clientScreen`, `hud`, `none` (the pixel driver additionally uses the driver-local `visual`/`unknown` classifiers).

**Driver kinds (`driverKind`):** `headless`, `inprocess-client`, `server`, `pixel`.
**MCTP `agent.kind` values (PROTOCOL.md §4.3):** `headlessBot`, `clientMod`, `serverPlugin`, `serverMod`, `pixelOcr`. (The `server` driver's Bukkit agent advertises `agent.kind: "serverPlugin"`; the Fabric server-mod variant advertises `"serverMod"`.)

**testId carriers:** NBT key `mctp:testId` (pre-1.20.5 inventory items); `mc-test:test_id` data component (1.20.5+); `TestIdHolder` interface / `WIDGET_ID` synthetic (client widgets).

**SUT extension SPIs (defined in `/agents/core`, pure Java):** `McTestStateProvider` (`Object query(String, Map)`) backs `truth.assertPluginState`; `McTestFixtureProvider` (`boolean supports(String)`, `Object apply(String, Map)`, `void undo(String)`) backs `fixture.set`/`fixture.reset`. SUTs register both via the Bukkit `ServicesManager`.

**Agent build-artifact naming:** Gradle fat jar `mc-test-agent-bukkit.jar`; resolver/install name `agent-server-bukkit-<mc>.jar` (the `agent-<variant>-<mc>.jar` convention). Plugin id `mc-test-agent`; config `plugins/mc-test-agent/config.yml` (`port:`); boot log line `MCTP listening on :PORT`.

**JSON-RPC error codes (driver-side; numeric values defined in `PROTOCOL.md`):**
`-32000 ELEMENT_NOT_FOUND` (selector matched zero),
`-32001 AMBIGUOUS_SELECTOR` (selector matched >1 without `nth`/`index`),
`-32002 METHOD_NOT_SUPPORTED` (method gated by an unadvertised capability),
`-32003 TIMEOUT` (`*.waitFor*` predicate not met in time),
`-32004 WORLD_NOT_READY` (world/session not ready for the call),
`-32005 FIXTURE_FAILED` (`fixture.set`/`fixture.reset` failed to apply),
`-32006 ASSERT_FAILED` (`truth.assertPluginState` failed or named probe unregistered),
`-32099 PROTOCOL_VERSION_UNSUPPORTED` (`session.create` protocol version mismatch).
Plus standard JSON-RPC `-32700`, `-32600`, `-32601`, `-32602`.
**Runner-level skip reason:** `NO_COMPATIBLE_DRIVER` (carries `unmet[]`) — used when no driver/pair satisfies the required caps, when a required `loader`/`mcVersionRange` target is unmet, or when `session.create` is rejected for a capability the driver lacks.

**Canonical probe / fixture names (regions example):** plugin-state query `regions.exists` (args `{ name: "TestRegion" }`, per `PROTOCOL.md` §7.5); fixture `regions.createRegion` (args `{ name: "TestRegion" }`); testId `regions:entry:TestRegion`, `regions:list`. (Earlier drafts used `regions.seed.TestRegion` / array args / dotted testIds — superseded by the `PROTOCOL.md` spellings.)

**Paths referenced:** `/packages/driver-headless`, `/packages/driver-inprocess`, `/packages/driver-pixel`, `/packages/runner`, `/packages/protocol`, `/agents/core`, `/agents/client-fabric`, `/agents/client-forge`, `/agents/client-neoforge`, `/agents/server-bukkit`, `/agents/server-fabric`, `mc-test.yml`.
