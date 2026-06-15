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

**World-truth primitives (server-side):**
- `truth.getWorldBlock` — `{ world, x, y, z } -> { type, blockData, nbt? }`.
- `truth.getEntities` — query entities by `{ world?, type?, near?, radius? }` -> `Entity[]`.
- `truth.assertPluginState` — evaluate a named, plugin-registered probe (e.g. `regions.exists("TestRegion")`) and return `{ ok, value, detail }`.

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
| `testId` | invisible tag emitted by SUTs we control | `{ "testId": "regions.entry.TestRegion" }` |

`testId` is the most robust: a cooperating plugin/mod stamps an invisible **NBT key** `mctp:testId` (inventory items) or **data component** `mc-test:test_id` (1.20.5+) or a mod-side widget `testId` field, and drivers resolve it deterministically. Drivers that cannot read tags (pixel) ignore `testId` and fall back to `label`/`textContains` via OCR.

A selector resolving to **zero** elements on a `screen.clickElement` raises `ELEMENT_NOT_FOUND`; resolving to **more than one** without `nth`/`index` raises `AMBIGUOUS_SELECTOR`.

### 0.3 `Element` shape (returned by `screen.listElements`)

```jsonc
{
  "ref": "el-7",                 // opaque, screen-scoped handle (stable within a screen)
  "label": "Regions",            // best-effort visible text
  "role": "button",              // button | slot | label | input | tab | list | listItem
  "testId": "regions.btn.list",  // present only if the SUT emitted one and the driver can read it
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
    "testIdTags": true,      // reads NBT mctp:testId / mc-test:test_id on items
    "screenshot": false,     // no framebuffer; see limits
    "rendering": false,
    "clientScreens": false,  // CANNOT — bare protocol, no client UI
    "worldTruth": "via-pair", // provided by paired server agent, not the bot itself
    "pluginState": "via-pair",
    "fixtures": "via-pair",
    "fakePlayers": "via-pair",
    "pressKey": false,       // no client to receive key events
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
| `screen.pressKey` | **Not supported** — no client to receive key events. Returns `METHOD_NOT_SUPPORTED`. (Use `screen.clickElement` or `world.runCommand` instead.) |
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
4. `screen.clickElement({ testId: "regions.entry.TestRegion" })` (or `{ label: "TestRegion" }`).
5. `world.waitForChat()` → assert a line `plain` contains `"Region loaded"` (assertion runs in the runner, not the bot).
6. Paired `server-bukkit`: `truth.assertPluginState({ probe: "regions.exists", args: ["TestRegion"] })` → `{ ok: true }`.

---

## 2. Driver: In-process client mod (`driver-inprocess` + `client-*` agents)

**Adapter package:** `/packages/driver-inprocess` (TypeScript) — speaks MCTP to the runner, forwards primitives to the in-game agent.
**Agents:** `/agents/client-fabric`, `/agents/client-forge`, `/agents/client-neoforge` (thin loader shims) over `/agents/core` (shared Java core).
**Kind:** `inprocess-client`.
**This is the ONLY driver that can see real client-rendered mod Screens.**

A **tiny dumb mod** runs inside the **real Minecraft client**. It embeds an MCTP **WebSocket server** (from `/agents/core`) and exposes primitives that reach into the client's screen/widget tree, keyboard, and framebuffer. The `driver-inprocess` adapter is a thin TS shim: most calls are forwarded 1:1 to the agent; the adapter exists so the runner only ever talks "north-side" MCTP and so reconnect/handshake policy lives in TS.

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
| `screen.get` | Read `MinecraftClient.getInstance().currentScreen`; return `{ screenId: screen.getClass().getName(), title: screen.getTitle().getString(), kind: classifyScreen(screen), size: {w,h} }`. `kind` ∈ `container|menu|hud|none`. |
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
- **The obfuscation/mappings tax is isolated here.** Only the shim recompiles per (loader × MC version). Fabric uses **Yarn**, Forge legacy uses **MCP/SRG**, NeoForge/modern uses **Mojmap (official mappings)**. Mixins/Access Wideners that reach private client fields (`ChatHud.messages`, `HandledScreen` slot click) are declared per mapping set. The matrix builds artifacts named `client-fabric-1.20.1.jar`, `client-neoforge-1.21.jar`, etc.
- Generating N artifacts is a build-matrix concern (Gradle `loom`/`neogradle` source sets), **not** a code-duplication concern: the core is compiled once; only the shim's mapping layer differs.

### 2.4 Build / runtime requirements

- JDK 17 (MC 1.17+) / JDK 8 (legacy ≤1.16) per target; Gradle with Fabric Loom / ForgeGradle / NeoGradle.
- A **real Minecraft client** launched with the SUT mod **and** the matching `client-*` agent jar in `mods/`. Launch offline (`--username Tester --uuid ... --accessToken 0`), no Microsoft auth.
- **Rendering surface**: a GPU or **Xvfb** (Linux headless) or a desktop CI runner (Windows/macOS). Docker image bundles Xvfb + Mesa for reproducibility.
- The agent opens its MCTP WS on a per-instance port (e.g. `25599`), advertised back to the runner.

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
4. `screen.clickElement({ testId: "regions.entry.TestRegion" })` (mod implements `TestIdHolder`).
5. `screen.screenshot()` on failure → PNG artifact.
6. `world.waitForChat()` → assert contains `"Region loaded"`. Server-truth half of the assertion runs on the paired `server-fabric` agent.

---

## 3. Driver: Server-side agent (`server-bukkit` / `server-fabric`)

**Agents:** `/agents/server-bukkit` (Bukkit/Paper plugin) and `/agents/server-fabric` (server-mod variant) over `/agents/core`.
**Kind:** `server`.
**Owns authoritative world-truth, plugin/mod-state assertions, fixtures, and fake players.**

This agent runs **inside the server JVM**. It is the source of ground truth: it reads the real world, queries SUT plugin state through registered probes, mutates state for setup, and spawns fake players. It does **no** client-side UI work — it has no screen. It is almost always **paired** with driver 1 or driver 2 (which drive the UI) to complete an assertion.

### 3.1 Capability set (advertised)

```jsonc
{
  "driverKind": "server",
  "capabilities": {
    "chat": true,             // can inject/observe server chat
    "command": true,          // runs console / player commands
    "worldTruth": true,       // authoritative
    "pluginState": true,
    "fixtures": true,
    "fakePlayers": true,
    "containerGui": false,    // no client; cannot click a rendered GUI
    "clientScreens": false,
    "typeText": false,
    "pressKey": false,
    "testIdTags": false,      // no client structure to read tags from
    "screenshot": false,
    "rendering": false,
    "pixelOnly": false        // driver-local marker (non-canonical); always false here
  }
}
```

### 3.2 How it implements each MCTP primitive

| MCTP method | Implementation in server agent |
|-------------|-------------------------------|
| `session.create`/`session.describe`/`session.close`/`session.ping` | Native in `/agents/core`, embedded in the plugin/mod's `onEnable`/`onInitialize`. WS server bound to a per-instance port. |
| `world.join`/`world.leave` | Marks the agent's logical session against the running world; no client connection of its own (the agent already lives in the server JVM). |
| `truth.getWorldBlock` | **Bukkit:** `world.getBlockAt(x,y,z)` → `{ type: block.getType().getKey(), blockData: block.getBlockData().getAsString(), nbt }`. **Fabric server:** `serverWorld.getBlockState(pos)`. Runs on the main server thread via the scheduler. |
| `truth.getEntities` | **Bukkit:** `world.getNearbyEntities(loc, r, r, r)` or `world.getEntities()` filtered by type → `Entity[]` `{ id, type, pos, name, customName }`. **Fabric:** `serverWorld.getEntitiesByType(...)`. |
| `truth.assertPluginState` | Looks up a **registered probe** by name in the agent's probe registry. SUT authors (or a shim) register probes at startup, e.g. `agent.registerProbe("regions.exists", args -> WorldGuard.getRegionManager(world).hasRegion(args[0]))`. Returns `{ ok, value, detail }`. Unknown probe → `ASSERT_FAILED`. |
| `fixture.set` | Applies a **named fixture** from the agent's fixture registry: place a schematic, create a region via the SUT's API, set time/weather, load a config file, give items. e.g. `fixture.set("regions.seed.TestRegion")`. Idempotent where possible. A fixture that fails to apply → `FIXTURE_FAILED`. |
| `fixture.reset` | Reverts applied fixtures, restoring the pristine world/plugin baseline (e.g. delete seeded regions, restore the world snapshot). |
| `player.spawnFake` | **Bukkit:** integrates **Carpet fake players** (`/player <name> spawn`) or a ProtocolLib/`packetevents` NPC; returns a handle `{ fakePlayerId, name }`. **Fabric:** Carpet/`FakePlayer` (`EntityPlayerMPFake`). The handle is usable as an actor for server-side actions (move, use item). |
| `player.despawnFake` | Despawns the handle (`/player <name> kill` or API). |
| `world.sendChat` | Broadcasts/injects chat; can also `player.performCommand` for a named (fake) player. |
| `world.runCommand` | Runs a **console command** (`Bukkit.dispatchCommand(consoleSender, cmd)`) or a named (fake) player's command. |
| `world.waitForChat` | Subscribes to server chat events (`AsyncPlayerChatEvent` / Fabric `ServerMessageEvents`) and broadcast log; blocks for a matching line and emits `event.chat`. |
| `screen.listElements`/`screen.get`/`screen.clickElement`/`screen.typeText`/`screen.pressKey`/`screen.screenshot`/`screen.close`/`screen.waitForScreen` | **Not supported** — the server has no client screen to introspect or click. All return `METHOD_NOT_SUPPORTED`. (UI is the bot's or client mod's job.) |

> Note on `containerGui`: even though container GUIs are *server-driven*, **clicking** one requires a connected client/bot to receive the open-window packet and send click packets. The server agent can *open* an inventory for a (fake) player but cannot itself perform the semantic `screen.clickElement`. So `containerGui` is advertised **false** here; the bot/client driver does the clicking, the server agent does the truth.

### 3.3 Version strategy — Bukkit API stability + packetevents

- **Bukkit/Paper API is broadly stable across versions**, so `server-bukkit` largely compiles once against a base API and runs on many server versions; only genuinely version-divergent calls (NMS, new registries) are isolated behind a small `ServerBridge` with version-guarded branches.
- **`packetevents`** provides a **cross-version, cross-platform** packet abstraction — the basis for portable behaviors (opening windows for fake players, observing packets) without per-version NMS. It also enables a **proxy-observer** mode where the agent watches packets between client and server.
- **`server-fabric`** (server-mod variant) pays a mappings tax like the client mod (Mojmap/Yarn), isolated in `/agents/core`'s `ServerBridge` Fabric impl; it covers Fabric/Quilt servers where no Bukkit API exists.
- **Carpet** supplies fake players across the versions it supports; the agent feature-detects Carpet and advertises `fakePlayers` accordingly (false if absent).
- SUT-specific probes/fixtures are registered by a tiny **SUT shim** the test author ships, keeping the agent dumb and the regions-specific knowledge (e.g. which region API to call) outside the core.

### 3.4 Build / runtime requirements

- JDK matching the server (17 for modern Paper/Fabric; 8 for legacy). Gradle; `server-bukkit` shades `/agents/core` + `packetevents` into a normal Paper plugin jar dropped in `plugins/`. `server-fabric` builds a server mod jar for `mods/`.
- Optional **Carpet** mod/plugin for fake players; optional **packetevents** (shaded).
- Runs headless inside the server container — no display.
- The runner provisions it Testcontainers-style: auto-download Paper/Fabric, copy a **pristine world snapshot**, install SUT + this agent, boot `online-mode=false` on a unique port.

### 3.5 Known limits / what it CANNOT do

- **No UI at all**: cannot click buttons, read client Screens, or screenshot. Always pair with a UI driver (1 or 2) for end-to-end GUI flows.
- **`truth.assertPluginState` needs a probe**: if the SUT ships no probe and none is registered, the assertion fails with `ASSERT_FAILED` — the framework cannot magically know plugin internals.
- **Fake players approximate clients**: Carpet bots don't render client GUIs; they cannot validate client-side mod screens.
- **NMS edge cases**: deeply version-specific server internals still require version-guarded code in `ServerBridge`.

### 3.6 Canonical regions example (server path)

The server agent provides **setup + the world-truth half** of the canonical assertion:
1. `fixture.set("regions.seed.TestRegion")` (optional) — pre-create the region so `/or` has data.
2. (UI driver runs `/or` → click "Regions" → click "TestRegion".)
3. `truth.assertPluginState({ probe: "regions.exists", args: ["TestRegion"] })` → `{ ok: true, value: true }`.
4. Optionally `truth.getWorldBlock` / `truth.getEntities` to verify region-side effects (e.g. a marker block placed at the region center).

---

## 4. Driver: Pixel / OCR (`driver-pixel`)

**Package:** `/packages/driver-pixel` (TypeScript).
**Kind:** `pixel`.
**Universal last resort. Brittle. Use only when no structural driver fits** (e.g. a closed-source client we cannot mod, or a rendering-only assertion).

This driver treats the screen as **pixels**: it captures a framebuffer (from a rendered client it does not instrument), runs **OCR** (Tesseract) and **template matching** (OpenCV) to locate text/elements, and dispatches **OS-level mouse/keyboard** events. It resolves semantic selectors **visually** — `label`/`textContains` via OCR, `itemType`/`role` via template images. It has **no structural knowledge**: no widget tree, no NBT, no `testId`.

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
**`screen.get` fields (this doc's shape):** `screenId`, `title`, `kind`, `size`, `elementCount`. **`kind` enum (driver-local):** `container`, `menu`, `hud`, `none`, `visual`, `unknown`.

**Driver kinds (`driverKind`):** `headless`, `inprocess-client`, `server`, `pixel`.

**testId carriers:** NBT key `mctp:testId` (pre-1.20.5 inventory items); `mc-test:test_id` data component (1.20.5+); `TestIdHolder` interface / `WIDGET_ID` synthetic (client widgets).

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

**Canonical probe / fixture names (regions example):** probe `regions.exists` (args `["TestRegion"]`); fixture `regions.seed.TestRegion`; testId `regions.entry.TestRegion`, `regions.btn.list`.

**Paths referenced:** `/packages/driver-headless`, `/packages/driver-inprocess`, `/packages/driver-pixel`, `/packages/runner`, `/packages/protocol`, `/agents/core`, `/agents/client-fabric`, `/agents/client-forge`, `/agents/client-neoforge`, `/agents/server-bukkit`, `/agents/server-fabric`, `mc-test.yml`.
