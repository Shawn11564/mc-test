# mc-test — Build Roadmap

> Status: planning. This document is the authoritative **build order** for mc-test. It defines the
> milestone sequence (M1 → M5), concrete acceptance criteria, what each milestone unlocks, a
> "testing the tester" strategy, and an honest "hard parts" register with mitigations.
>
> The architecture is a **narrow waist**: write a test once in semantic steps, pin everything to one
> stable contract — the **MC Test Protocol (MCTP)**, JSON-RPC 2.0 over WebSocket with Appium-style
> capability negotiation — and swap **drivers** underneath, selected per target by capabilities.
> This roadmap uses the canonical method, capability key, selector key, and `mc-test.yml` field names
> throughout so it aligns with the sibling design docs. Those names are **defined canonically in
> `PROTOCOL.md`**, the single source of truth for the wire contract; this roadmap defers to `PROTOCOL.md`
> for their definition and is itself authoritative for **build order, milestone scope, and acceptance
> criteria**.

---

## 0. Guiding principles (carried into every milestone)

These are non-negotiable and constrain how each milestone is allowed to be built:

1. **Protocol-first.** MCTP is the keystone. Every backend is "just another driver." The runner
   language (TypeScript) and the in-game language (Java) are decoupled by the protocol. No milestone
   may introduce a runner→driver coupling that bypasses MCTP.
2. **Push version-specific code into tiny dumb agents.** In-game agents expose **primitives only**
   (`listElements`, `clickElement`, `getScreen`, `typeText`, `pressKey`, `screenshot`,
   `getWorldBlock`, `getEntities`, `setFixture`, `spawnFakePlayer`, `assertPluginState`). All
   intelligence — selector resolution strategy orchestration, assertions, retries, reporting — lives
   **outside** the game in version-independent TypeScript. Only the thin agent recompiles per
   `(loader × version)`.
3. **Semantic selectors, never coordinates.** A test says `clickElement(label "Regions")`. Each
   driver resolves it (bot → inventory slot display-name; client mod → `ClickableWidget.getMessage`;
   pixel → OCR/template). Slot indices and pixel coordinates never appear in a test.
4. **Capability negotiation.** Drivers advertise capabilities; tests declare required capabilities;
   the runner picks a compatible driver and **skips with a clear reason** when none fits. Fast plugin
   tests run headless in CI; only true client-GUI mod tests pay for a rendered client.
5. **Honest skips beat false greens.** A test that cannot run on the selected driver is reported as
   `skipped` with a machine-readable reason — never silently passed.

---

## 1. Milestone map (the build order at a glance)

| ID | Milestone | Primary deliverable(s) | Depends on | Unlocks |
|----|-----------|------------------------|-----------|---------|
| **M1** | **The contract** | `/packages/protocol` — MCTP types + JSON Schema + capability defs | — | A frozen wire format every driver and the runner code against. |
| **M2** | **Runner + first driver** | `/packages/runner` (CLI, YAML, JUnit) + `/packages/driver-headless` (Mineflayer) against `/examples/regions` | M1 | Real end-to-end headless plugin tests in CI. The whole loop is alive. |
| **M3** | **Server-side truth** | `/agents/server-bukkit` plugin agent (world-truth + fixtures + plugin-state) | M1, M2 | Assertions against **real** server state; deterministic fixtures; the canonical regions assertion. |
| **M4** | **Client GUI** | `/agents/client-fabric` in-process agent + `/packages/driver-inprocess` | M1, (M2 patterns) | Testing **real mod client Screens** — the only thing the bot fundamentally cannot see. |
| **M5** | **Fan-out** | `/agents/client-forge`, `/agents/client-neoforge`, `/agents/server-fabric`, version matrix | M3, M4 | The full `(loader × version)` matrix from one shared agent core. |

Rationale for this order: **M1 first** because the contract is the keystone and changing it later is
the most expensive change in the system. **M2 next** because a headless driver gives us a real,
fast, CI-friendly end-to-end loop with the least moving parts (no JVM agent, no rendering, no
mappings) — it proves the protocol and the authoring layer are sound before we pay any per-version
tax. **M3 before M4** because server-side world-truth is the highest-value, lowest-pain agent (a
Bukkit plugin needs no obfuscation mappings against a stable API) and it completes the canonical
regions assertion. **M4** is the hardest single agent (client mappings + rendering) and benefits
from every lesson learned in M1–M3. **M5** is mechanical fan-out once the shared core and one client
agent exist.

---

## 2. M1 — `/packages/protocol`: the MC Test Protocol (MCTP)

**Goal:** freeze the one contract everything else codes against. No game, no runner logic — just
types, schema, capability definitions, and a conformance fixture.

### 2.1 Scope / deliverables

```
/packages/protocol
  package.json            # name: @mc-test/protocol
  src/
    mctp.ts               # TS types for envelopes, params, results, errors
    capabilities.ts       # capability key enum + RequiredCapabilities / Capabilities types
    selectors.ts          # Selector type (the semantic selector union)
    methods.ts            # method-name string-literal union + param/result maps
    index.ts              # public barrel export
  schema/
    mctp-request.schema.json
    mctp-response.schema.json
    mctp-notification.schema.json
    capabilities.schema.json
    selector.schema.json
    methods/                # one request+result schema pair per method
      session.create.schema.json
      ...
  fixtures/
    conformance/            # golden request/response JSON used by every driver's test suite
  README.md
```

### 2.2 Transport & envelope (frozen in M1)

- **Transport:** WebSocket. One socket per session. Text frames carrying UTF-8 JSON.
- **Encoding:** JSON-RPC 2.0. `id` is a string (UUID) or integer. Requests, success responses, error
  responses, and server→client **notifications** (no `id`) are all supported.
- **Direction:** the **runner is the JSON-RPC client**, the **agent/driver-side is the server** (it
  listens). The driver-headless is a special case — see M2 §3.2 — but the *envelope* is identical.
- **Versioning:** every connection begins with `session.create`, which negotiates a `protocolVersion`
  (semantic, starts at `"1.0"`). Mismatch → connection rejected with error `-32099`
  (`PROTOCOL_VERSION_UNSUPPORTED`).

### 2.3 MCTP method catalog (canonical names — defined in `PROTOCOL.md`)

Methods are namespaced `noun.verb`. **This is the complete M1 surface.** Drivers implement the subset
their capabilities allow; unimplemented methods return error `-32601` style
`METHOD_NOT_SUPPORTED` (see §2.6).

**Session & lifecycle**

| Method | Params (key fields) | Result | Notes |
|--------|---------------------|--------|-------|
| `session.create` | `protocolVersion`, `requiredCapabilities`, `target` | `{ sessionId, protocolVersion, capabilities }` | Capability negotiation handshake. |
| `session.describe` | — | `{ capabilities, driver, mcVersion, loader }` | Introspection; cheap, side-effect free. |
| `session.close` | `{ reason? }` | `{ ok: true }` | Graceful teardown. |
| `session.ping` | `{ nonce }` | `{ nonce }` | Liveness / RTT. |

**Connection & world entry (driver-level, not always agent-level)**

| Method | Params | Result |
|--------|--------|--------|
| `world.join` | `{ host, port, username, auth? }` | `{ ok, dimension, position }` |
| `world.leave` | `{ reason? }` | `{ ok }` |
| `world.sendChat` | `{ message }` | `{ ok }` |
| `world.runCommand` | `{ command }` (no leading `/`) | `{ ok, ack? }` |
| `world.waitForChat` | `{ contains?, regex?, timeoutMs }` | `{ matched, line, lines }` |

**Screen / GUI primitives (the heart of the protocol)**

| Method | Params | Result |
|--------|--------|--------|
| `screen.get` | `{ }` | `{ screen: ScreenSnapshot }` — current screen/container + element tree |
| `screen.listElements` | `{ selector?, within? }` | `{ elements: Element[] }` |
| `screen.clickElement` | `{ selector, button?, count? }` | `{ ok, clicked: ElementRef }` |
| `screen.typeText` | `{ selector?, text }` | `{ ok }` |
| `screen.pressKey` | `{ key, mods? }` | `{ ok }` — key is a semantic name (`"ENTER"`, `"ESCAPE"`) |
| `screen.screenshot` | `{ format?: "png", region? }` | `{ image: base64, width, height }` |
| `screen.waitForScreen` | `{ titleContains?, hasElement?, timeoutMs }` | `{ matched, screen }` |
| `screen.close` | `{ }` | `{ ok }` — close the current screen (ESC semantics) |

**World-truth primitives (server agent)**

| Method | Params | Result |
|--------|--------|--------|
| `truth.getWorldBlock` | `{ world, x, y, z }` | `{ block: { type, state, nbt? } }` |
| `truth.getEntities` | `{ world?, near?, type?, radius? }` | `{ entities: Entity[] }` |
| `truth.assertPluginState` | `{ plugin, query, expect? }` | `{ ok, value }` — generic plugin-state probe |

**Fixtures & test-doubles (server agent)**

| Method | Params | Result |
|--------|--------|--------|
| `fixture.set` | `{ name, spec }` | `{ ok, fixtureId }` — apply a named fixture (regions, perms, items…) |
| `fixture.reset` | `{ fixtureId? }` | `{ ok }` — revert; no arg = revert all in session |
| `player.spawnFake` | `{ username, at? }` | `{ ok, playerId }` — Carpet-style fake player |
| `player.despawnFake` | `{ playerId }` | `{ ok }` |

**Notifications (server→runner, no `id`)**

| Notification | Payload |
|--------------|---------|
| `event.chat` | `{ line, raw, sender? }` |
| `event.screenChanged` | `{ screen: ScreenSnapshot }` |
| `event.log` | `{ level, message, source }` |
| `event.disconnected` | `{ reason }` |

> The method names above (`session.create`, `world.runCommand`, `screen.clickElement`,
> `truth.assertPluginState`, `fixture.set`, `player.spawnFake`, …) and the primitive verbs from the
> Prime Directives (`listElements`, `clickElement`, `getScreen`, `typeText`, `pressKey`, `screenshot`,
> `getWorldBlock`, `getEntities`, `setFixture`, `spawnFakePlayer`, `assertPluginState`) are the same
> operations. The wire uses the **namespaced** form; the agent SDK exposes the **bare** primitive
> verb. Both names are reserved and must not be repurposed.

### 2.4 Capability keys (canonical — drivers advertise, tests require)

Capabilities are a flat string-keyed map of booleans (with a few enum/string values). Defined in
`capabilities.ts` and `capabilities.schema.json`.

| Capability key | Type | Meaning |
|----------------|------|---------|
| `chat` | bool | Can send/receive chat. |
| `command` | bool | Can run slash commands. |
| `containerGui` | bool | Can read/operate **server-driven inventory/chest GUIs** (the bot path). |
| `clientScreens` | bool | Can read/operate **client-rendered mod Screens/widgets** (the client-mod path). |
| `screenshot` | bool | Can capture pixels. |
| `rendering` | bool | A real GPU/framebuffer client is present (implies `screenshot`). |
| `worldTruth` | bool | Can read authoritative server world/block/entity state. |
| `pluginState` | bool | Can assert on plugin internal state. |
| `fixtures` | bool | Can apply/reset fixtures. |
| `fakePlayers` | bool | Can spawn/despawn fake players. |
| `typeText` | bool | Can type into fields. |
| `pressKey` | bool | Can send semantic key presses. |
| `testIdTags` | bool | Target emits invisible `testId` tags the driver can resolve (see §2.5). |
| `loader` | enum string | `"spigot" \| "paper" \| "folia" \| "fabric" \| "forge" \| "neoforge" \| "quilt" \| "vanilla"`. |
| `mcVersionRange` | string | semver-ish range the driver supports, e.g. `">=1.8 <=1.21.4"`. |

A **`RequiredCapabilities`** object on a test is a partial of the above; the runner matches a test to
a driver iff every required key is satisfied (`true` matched by `true`; `loader` matched by
membership; `mcVersionRange` matched by intersection). Otherwise → **skip with reason**
`NO_COMPATIBLE_DRIVER` carrying the unmet keys.

### 2.5 Selector model (canonical selector keys)

`Selector` (in `selectors.ts` / `selector.schema.json`) is an object where **all present keys are
ANDed**. Resolution strategy is the driver's job; the *shape* is fixed:

| Selector key | Type | Resolution intent |
|--------------|------|-------------------|
| `label` | string | Exact visible text / display-name match. |
| `text` | string | Alias of `label` for free-text elements (buttons, labels). |
| `textContains` | string | Substring match on visible text. |
| `loreContains` | string | Substring match within item lore / tooltip lines. |
| `itemType` | string | Namespaced item id (`minecraft:diamond`) for inventory elements. |
| `role` | string | Semantic role: `button \| slot \| label \| input \| tab \| list \| listItem`. |
| `index` | int | 0-based positional disambiguator among matches. |
| `nth` | int | Alias of `index` (1-based) for readability in YAML. |
| `within` | Selector | Scope: match only inside the element(s) matched by this sub-selector. |
| `testId` | string | Match an **invisible test tag** emitted by SUTs we control (NBT key `mctp:testId` / data component `mc-test:test_id`). Most robust; requires `testIdTags`. |

If a selector matches **zero** elements → method returns error `ELEMENT_NOT_FOUND`. If it matches
**more than one** and no `index`/`nth` is given → error `AMBIGUOUS_SELECTOR` listing the candidates.
(Retries/waits are the **runner's** job, layered on top — agents never retry.)

### 2.6 Error model (canonical codes)

JSON-RPC `error.code` uses standard ranges plus an mc-test reserved block. `error.data` carries a
stable string `reason` and structured detail.

| Code | `reason` | Meaning |
|------|----------|---------|
| `-32700 / -32600 / -32601 / -32602` | (JSON-RPC standard) | parse / invalid request / method-not-found / invalid-params |
| `-32000` | `ELEMENT_NOT_FOUND` | Selector matched nothing. |
| `-32001` | `AMBIGUOUS_SELECTOR` | Selector matched >1 with no disambiguator. |
| `-32002` | `METHOD_NOT_SUPPORTED` | Driver lacks the capability for this method. |
| `-32003` | `TIMEOUT` | A `waitFor*` exceeded `timeoutMs`. |
| `-32004` | `WORLD_NOT_READY` | Not joined / screen not open / fixture missing. |
| `-32005` | `FIXTURE_FAILED` | Fixture spec could not be applied. |
| `-32006` | `ASSERT_FAILED` | An agent-side assert (e.g. `assertPluginState expect`) did not hold. |
| `-32099` | `PROTOCOL_VERSION_UNSUPPORTED` | Handshake version mismatch. |

### 2.7 Acceptance criteria (M1 is "done" when…)

- [ ] `@mc-test/protocol` builds with `tsc --strict` and ships `.d.ts` + the published JSON Schema.
- [ ] Every method in §2.3 has: a TS param type, a TS result type, and a JSON Schema pair under
      `schema/methods/`. `methods.ts` exports a `MethodName` union and a compile-time map
      `MctpMethods[name] = { params; result }`.
- [ ] `capabilities.ts` exports the capability key union and `matchCapabilities(required, advertised)`
      returning `{ ok: boolean; unmet: string[] }` — pure, unit-tested.
- [ ] `selectors.ts` exports `Selector` and a pure `describeSelector(s): string` (used in skip/error
      messages and reports, e.g. `label="Regions" within(role=tab)`).
- [ ] A **conformance fixture suite** exists under `fixtures/conformance/`: for each method, ≥1 golden
      request and ≥1 golden success/error response that **validate against the schema** in CI. A test
      `validate-fixtures.test.ts` proves every fixture matches its schema (this is the contract any
      future driver must satisfy).
- [ ] JSON Schema and TS types are proven **in sync**: a generator or a round-trip test fails CI if
      they drift (e.g. `ts-json-schema-generator` snapshot compared to the committed schema).
- [ ] No dependency on any game, Mineflayer, or JVM. The package is pure data + functions.

### 2.8 What M1 unlocks

The runner and **every** driver — present and future — now have one stable target. Two teams can work
in parallel against the frozen schema: a TypeScript runner team and a Java agent team, in different
languages, with conformance fixtures as the shared truth.

---

## 3. M2 — `/packages/runner` + `/packages/driver-headless` (runnable end-to-end)

**Goal:** make the whole loop **alive** with the least moving parts: author a test once, run it
headless via Mineflayer, get a JUnit report — against the canonical `/examples/regions` target. No
JVM agent yet; world-truth assertions are stubbed/deferred to M3 and declared as a required capability
the headless driver does **not** advertise (so the truth half of the regions test honestly **skips**
until M3).

### 3.1 Scope / deliverables

```
/packages/runner
  package.json            # name: @mc-test/runner ; bin: mc-test
  src/
    cli.ts                # `mc-test run`, `mc-test list`, `mc-test doctor`
    config/
      loadMatrix.ts       # parse + validate mc-test.yml
      loadSteps.ts        # parse YAML step files / .mctest.yml
    model/
      Test.ts, Step.ts, Target.ts
    engine/
      Runner.ts           # orchestration: select driver, run steps, retries, waits
      SelectorWaits.ts    # retry/poll loop wrapping selector resolution
      CapabilityMatch.ts  # uses @mc-test/protocol matchCapabilities
      Session.ts          # MCTP JSON-RPC client over ws
    drivers/
      DriverRegistry.ts   # capability-keyed driver selection
      MctpClient.ts       # transport: ws + JSON-RPC 2.0 framing
    report/
      JUnitReporter.ts    # JUnit XML
      Artifacts.ts        # screenshots, logs, (optional) video on failure
    authoring/
      fluent.ts           # write-once fluent API (TS): join().command().click()...
  README.md

/packages/driver-headless
  package.json            # name: @mc-test/driver-headless
  src/
    HeadlessDriver.ts     # boots Mineflayer, opens an MCTP WebSocket server
    primitives/
      world.ts            # world.join/leave/sendChat/runCommand/waitForChat
      containerGui.ts     # screen.* mapped onto Mineflayer window/inventory
      selectorResolve.ts  # Selector -> inventory slot (display-name/lore/itemType)
    via/
      viaProxy.ts         # optional ViaVersion/ViaProxy front for version spanning
    capabilities.ts       # advertises: chat, command, containerGui, typeText, pressKey...
  README.md

/examples/regions
  README.md               # how to stand up the minimal target
  plugin/                 # minimal "regions" plugin source (/or -> GUI -> Regions -> TestRegion)
  world-snapshot/         # pristine world used per test
  regions.mctest.yml      # the canonical step file
  regions.fluent.test.ts  # the same test in the fluent API
```

### 3.2 How the headless driver speaks MCTP

Mineflayer is a Node library, so the headless driver is **in-process with the runner is allowed but
not assumed**. To keep the protocol-first rule honest, the driver hosts a real **MCTP WebSocket
server** (default `ws://127.0.0.1:0`, ephemeral port) and the runner connects as a client exactly as
it will to a JVM agent. This guarantees the runner has **zero** special-casing for headless vs. agent
drivers — same `MctpClient`, same envelopes, same conformance fixtures.

Primitive mapping (headless):
- `world.*` → Mineflayer `bot.chat`, `bot.on('messagestr')`, command send.
- `screen.listElements` / `clickElement` → Mineflayer `bot.currentWindow.slots`; an element's
  `label` = item display-name, `loreContains` = lore lines, `itemType` = `block`/`item` name.
  `screen.clickElement` → `bot.clickWindow(slot, 0, 0)`.
- `screen.screenshot` → **not advertised** (`screenshot:false`, `rendering:false`). A test requiring
  `screenshot` skips on this driver with reason `NO_COMPATIBLE_DRIVER`.
- `truth.*`, `fixture.*`, `player.*` → **not advertised** (`worldTruth:false`, etc.). Deferred to M3.

### 3.3 Authoring surfaces (write once)

Both compile to the **same** internal `Test`→`Step[]` model and run identically.

**YAML step file** (`regions.mctest.yml`) — canonical field names:

```yaml
name: regions-open-testregion
requires:                     # RequiredCapabilities (subset of §2.4 keys)
  command: true
  containerGui: true
target: ${matrix}             # filled by mc-test.yml row, or an explicit target ref
steps:
  - join: { host: localhost, port: 25565, username: Tester }
  - command: "or"             # runs /or
  - waitForScreen: { titleContains: "OpenRegions" }
  - click: { label: "Regions" }
  - click: { label: "TestRegion" }
  - assertChat: { contains: "Region loaded" }
  # The server-truth half is declared but will SKIP until M3 provides worldTruth/pluginState:
  - assertPluginState:
      requires: { pluginState: true }
      plugin: "OpenRegions"
      query: "regions.exists"
      args: { name: "TestRegion" }
      expect: true
```

**Fluent API** (`regions.fluent.test.ts`) — same semantics:

```ts
import { test } from "@mc-test/runner";

test("regions-open-testregion")
  .requires({ command: true, containerGui: true })
  .join({ host: "localhost", port: 25565, username: "Tester" })
  .command("or")
  .waitForScreen({ titleContains: "OpenRegions" })
  .click({ label: "Regions" })
  .click({ label: "TestRegion" })
  .assertChat({ contains: "Region loaded" })
  .assertPluginState({                 // skipped honestly until M3
    requires: { pluginState: true },
    plugin: "OpenRegions", query: "regions.exists",
    args: { name: "TestRegion" }, expect: true,
  });
```

### 3.4 Step → MCTP mapping (canonical step verbs)

| Step verb (YAML/fluent) | MCTP call(s) | Required capability |
|-------------------------|--------------|---------------------|
| `join` | `world.join` | `command`/`chat` (implied by step) |
| `leave` | `world.leave` | — |
| `chat` | `world.sendChat` | `chat` |
| `command` | `world.runCommand` | `command` |
| `waitForChat` / `assertChat` | `world.waitForChat` | `chat` |
| `waitForScreen` | `screen.waitForScreen` | `containerGui` or `clientScreens` |
| `listElements` | `screen.listElements` | `containerGui` or `clientScreens` |
| `click` | `screen.clickElement` (wrapped by `SelectorWaits`) | `containerGui` or `clientScreens` |
| `type` | `screen.typeText` | `typeText` |
| `press` | `screen.pressKey` | `pressKey` |
| `screenshot` | `screen.screenshot` | `screenshot` |
| `getBlock` | `truth.getWorldBlock` | `worldTruth` |
| `getEntities` | `truth.getEntities` | `worldTruth` |
| `assertPluginState` | `truth.assertPluginState` | `pluginState` |
| `fixture` | `fixture.set` / `fixture.reset` | `fixtures` |
| `spawnFakePlayer` | `player.spawnFake` | `fakePlayers` |

The `SelectorWaits` engine wraps **every** selector-bearing step in a poll loop
(`intervalMs` default 250, `timeoutMs` default 5000) so that `ELEMENT_NOT_FOUND` is retried by the
**runner** until timeout — never by the agent. This is where "intelligence outside the game" is most
visible.

### 3.5 Minimal provisioning for M2

M2 ships a deliberately small provisioner (`mc-test doctor` + the run path) that can:
- download a Paper jar from the Paper API (and fall back to the Mojang version manifest);
- write a `server.properties` with `online-mode=false`, `eula=true`;
- copy `/examples/regions/world-snapshot/` to a fresh temp dir per test (isolation + parallel ports);
- drop the `/examples/regions/plugin/` jar into `plugins/`;
- boot, wait for "Done", run the suite, shut down, collect logs.

Full Testcontainers/Docker + the agent installation come online with M3.

### 3.6 Acceptance criteria (M2 is "done" when…)

- [ ] `npx mc-test run examples/regions/regions.mctest.yml --target paper-1.20.4` **boots a Paper
      server, joins with Mineflayer, runs `/or`, clicks "Regions" then "TestRegion", asserts chat
      contains "Region loaded", and writes a green JUnit case** — fully unattended, `online-mode=false`.
- [ ] The **same** test expressed via the fluent API (`regions.fluent.test.ts`) produces an identical
      pass.
- [ ] The `assertPluginState` step is reported `skipped` with reason `NO_COMPATIBLE_DRIVER`
      (`unmet: ["pluginState"]`) — proving honest skips work and setting up M3.
- [ ] JUnit XML validates against the JUnit schema and is consumed cleanly by a stock CI (GitHub
      Actions test reporter). On failure, an artifacts bundle (server log + last chat lines; no
      screenshot since headless) is attached.
- [ ] Driver selection is capability-driven via `DriverRegistry` + `matchCapabilities` from
      `@mc-test/protocol` — **no hard-coded "use headless"** branch in the engine.
- [ ] The headless driver passes the **M1 conformance fixtures** for every method it advertises.
- [ ] A second target row (`paper-1.8.9` via ViaProxy) runs the **same** test file unchanged, proving
      version-spanning for the headless path (or skips with a precise reason if Via cannot bridge —
      see Hard Parts §7.4).

### 3.7 What M2 unlocks

A real, fast, CI-runnable plugin-testing product for everything a **server-driven GUI** can express
(chest menus, anvil text, sign input) across the versions Mineflayer+Via cover. Most plugin GUIs are
exactly this. The authoring layer, reporter, capability matching, and provisioning skeleton are now
battle-tested for the harder agents to reuse.

---

## 4. M3 — `/agents/server-bukkit`: world-truth, fixtures, plugin-state

**Goal:** add the **authoritative** half. A Bukkit/Paper plugin agent that boots inside the test
server and serves `truth.*`, `fixture.*`, `player.*` over MCTP. This completes the canonical regions
assertion (the region **actually exists** server-side) and makes tests deterministic via fixtures.
Crucially, a Bukkit plugin codes against the **stable Bukkit API** — **no obfuscation mappings** — so
this is the highest-value, lowest-pain agent.

### 4.1 Scope / deliverables

```
/agents/core                         # shared Java agent core (also used by M4/M5)
  build.gradle.kts
  src/main/java/.../core/
    MctpServer.java                   # WebSocket + JSON-RPC 2.0 server (Java-WebSocket + Gson/Jackson)
    Dispatch.java                     # method-name -> PrimitiveHandler registry
    PrimitiveHandler.java             # interface: handle(params) -> result | error
    SelectorMatch.java                # shared selector AST eval over an abstract ElementModel
    ElementModel.java                 # loader-neutral element/snapshot DTOs (mirror @mc-test/protocol)
    Errors.java                       # the §2.6 error codes
    Capabilities.java                 # builds the advertised capability map

/agents/server-bukkit
  build.gradle.kts                    # Paper/Spigot API; shades /agents/core
  src/main/java/.../bukkit/
    McTestAgentPlugin.java            # JavaPlugin entrypoint; starts MctpServer on configured port
    truth/
      WorldTruth.java                 # truth.getWorldBlock / getEntities (Bukkit World API)
      PluginStateProbe.java           # truth.assertPluginState via a small SPI (see §4.3)
    fixtures/
      FixtureManager.java             # fixture.set / fixture.reset (named, reversible)
    players/
      FakePlayerManager.java          # player.spawnFake / despawnFake (NPC/Carpet-style)
    gui/
      ServerGuiBridge.java            # OPTIONAL: observe server-opened inventories for cross-checks
  src/main/resources/plugin.yml
  README.md
```

### 4.2 How the server agent is provisioned (extends M2 §3.5)

The runner's provisioner now also drops `mc-test-agent-bukkit.jar` into `plugins/` alongside the SUT,
and reads the agent's MCTP port from a known file/log line (`event.log` "MCTP listening on :PORT").
A **target** in `mc-test.yml` that requests `worldTruth/pluginState/fixtures` causes the runner to
**co-select** the server agent and the headless driver for one logical session (the runner may hold
**two** MCTP connections — the *driver* connection for GUI/chat, the *agent* connection for truth —
unified behind one `Session`). This is the first multi-connection session and is a deliberate design
point: drivers and agents are independent MCTP servers; the `Session` fans a step to whichever
connection advertises the capability.

### 4.3 Plugin-state probe SPI (how generic assertions stay generic)

`truth.assertPluginState` must work without the agent knowing every plugin. Two layers:

1. **Reflective/Services probe (zero SUT changes):** `PluginStateProbe` resolves `plugin` by name via
   `Bukkit.getPluginManager()`, then evaluates `query` against a small expression grammar
   (`regions.exists(name)`, `perms.has(player, node)`, `config.get(path)`) using the plugin's
   public API or Bukkit `ServicesManager` registrations where available.
2. **Opt-in SUT hook (robust):** SUTs we control can register a
   `org.bukkit.plugin.ServicePriority` service `McTestStateProvider` (interface shipped in
   `/agents/core`) exposing `Object query(String q, Map args)`. The canonical `/examples/regions`
   plugin registers one so `regions.exists name=TestRegion` returns a real boolean from the region
   store. `testId` tags (§2.5) are the GUI analog of this opt-in path.

If neither path can answer → error `ASSERT_FAILED` (not a silent pass), with `data.reason` explaining
that the plugin exposed no probe for `query`.

### 4.4 Fixtures (deterministic setup)

`fixture.set { name, spec }` applies a **named, reversible** mutation and records an undo so
`fixture.reset` restores pristine state (belt-and-suspenders with the per-test world snapshot from
M2). M3 ships these built-in fixture kinds (extensible via the same SPI):

- `regions` — create/delete named regions (used by the canonical example to guarantee `TestRegion`).
- `inventory` — give/clear items for a (fake or real) player.
- `permissions` — grant/revoke nodes.
- `gamerule` / `time` / `weather` — world determinism.

### 4.5 Acceptance criteria (M3 is "done" when…)

> **M3 status note (2026-06-15).** The M3 build landed `/agents/core`, `/agents/server-bukkit`,
> the runner's multi-connection fan-out (`SessionGroup`), and the `/examples/regions` SPI
> registration, with the design docs synced to the shipped names/shapes (this change). The
> **integration build was executed and is green**: `gradle :core:build :core:publishToMavenLocal`
> → `gradle :server-bukkit:build` → `mvn -f examples/regions/plugin/pom.xml package` → runner
> `npm test` all pass (the `/agents/core` `ConformanceTest` replays the M1 `truth.*`/`fixture.*`/
> `player.*` golden fixtures against a real `MctpServer` and passes; the fat plugin jar bundles
> Java-WebSocket + core with **zero** Bukkit/Gson/Paper leakage). The boxes ticked below are the
> ones proven by that build and by the runner's no-boot M3 test suite
> (`packages/runner/test/m3.test.ts` against `mockServerAgent.ts`: regions-green, honest-skip,
> truth/UI-divergence, fixture-driven, fan-out routing). The boxes that remain **unticked**
> require a **real Paper(+Carpet) boot** of the live two-connection session (which this
> environment does not run) — their no-boot mock equivalents are noted inline and do pass. See
> §7.3 ("testing the tester") and §9.

- [ ] The canonical regions test now runs to **full green including** the previously-skipped
      `assertPluginState { plugin: OpenRegions, query: regions.exists, args: { name: TestRegion },
      expect: true }` — the runner proves the region exists in **real** server state, not just chat.
      *(Real-boot acceptance. The no-boot mock-agent equivalent — full green including
      `assertPluginState` against a mock `serverPlugin` agent — is covered by the runner M3 tests.)*
- [ ] A fixture-driven variant passes: `fixture: { name: regions, spec: { create: ["TestRegion"] } }`
      at setup and `fixture.reset` at teardown leave the world pristine (verified by a second run on
      the same snapshot with the fixture **omitted** correctly failing `regions.exists`).
      *(Real-boot acceptance; the no-boot equivalent — `fixture.set regions.createRegion` makes a later
      `regions.exists` true, absent it false — is covered by the runner M3 mock-agent tests.)*
- [ ] `truth.getWorldBlock` and `truth.getEntities` return correct values for a known seeded world
      (e.g. assert a placed beacon at a coordinate; assert a spawned villager count).
      *(Real-boot acceptance; seeded-value routing is exercised against the mock agent with no boot.)*
- [ ] `player.spawnFake { username: Bot2 }` makes a fake player visible to both the server
      (`truth.getEntities type=player`) and the headless bot in the same world.
      *(Real-boot acceptance; the mock agent proves a spawned fake appears in `getEntities` with no boot.)*
- [x] The server agent passes the **M1 conformance fixtures** for `truth.*`, `fixture.*`, `player.*`.
      *(Proven: `/agents/core` `ConformanceTest` boots a real `MctpServer` with stub `truth.*`/
      `fixture.*`/`player.*` handlers and replays the golden fixtures — `gradle :core:test` is green,
      covering `getWorldBlock`, `getEntities`, `assertPluginState`, `fixture.set`/`reset`,
      `spawnFake`/`despawnFake`, plus negotiation grant/refuse and constraint refusal.)*
- [x] One `Session` transparently fans GUI steps to the headless driver and truth steps to the Bukkit
      agent — the **test author writes no connection plumbing**.
      *(Proven by the runner M3 tests via `SessionGroup` + a mock `serverPlugin` agent, with no
      Minecraft boot: GUI verbs route to the driver, `truth.*`/`fixture.*`/`player.*` to the agent,
      and the agent receives only the truth/session calls. The live-pairing against a real Paper
      boot is the stronger real-boot form.)*
- [ ] Built with the Bukkit/Paper API only; CI confirms **no Mojang-mapped/NMS symbols** are
      referenced (so M3 needs no per-version remap — a `1.20.4` and a `1.21.x` build differ only by
      the API artifact version).
      *(Gated on the `/agents/server-bukkit` build + import-scan check during the integration build.)*

### 4.6 What M3 unlocks

True plugin testing: assertions on the server's own state and behavior, deterministic fixtures, fake
players for multiplayer scenarios, and the **complete** canonical regions story. Combined with M2,
this is a credible CI product for the entire Spigot/Paper plugin ecosystem **without ever rendering a
client**.

---

## 5. M4 — `/agents/client-fabric` + `/packages/driver-inprocess` (real client Screens)

**Goal:** the one thing the bot fundamentally cannot do — drive **real, client-rendered mod
Screens/widgets**. A tiny Fabric mod loads inside the **real** client, hosts MCTP, and serves
`screen.*` + `screenshot` against Minecraft's actual `Screen`/`ClickableWidget` tree. The
`driver-inprocess` package is the runner-side adapter that talks to it and that knows how to **launch
and babysit a rendered client** (Xvfb/desktop) as part of a session.

### 5.1 Scope / deliverables

```
/agents/client-fabric
  build.gradle.kts                    # Fabric Loom; depends on /agents/core; Yarn mappings
  src/main/java/.../clientfabric/
    McTestClientMod.java              # ClientModInitializer; starts MctpServer client-side
    screen/
      ScreenInspector.java            # walks current `Screen` -> ElementModel (widgets, labels)
      WidgetClicker.java              # screen.clickElement -> synthesize widget click at runtime
      TextTyper.java                  # screen.typeText into focused TextFieldWidget
      KeyPresser.java                 # screen.pressKey via semantic key map -> GLFW/keyCodes
      Screenshotter.java              # screen.screenshot from the framebuffer
      ScreenEvents.java               # emits event.screenChanged notifications
    mappings/
      Names.java                      # ISOLATED obfuscation-mapping shims (Yarn) — the only taxed file
  src/main/resources/fabric.mod.json
  README.md

/packages/driver-inprocess
  package.json                        # name: @mc-test/driver-inprocess
  src/
    InProcessDriver.ts                # MCTP client to the in-game client agent
    launch/
      ClientLauncher.ts               # downloads/launches the client (offline), injects the mod
      Display.ts                      # Xvfb (Linux) / native desktop selection
    capabilities.ts                   # advertises clientScreens, rendering, screenshot, typeText...
  README.md
```

### 5.2 The mapping discipline (why M4 is survivable)

Per the Prime Directives, **all version-specific obfuscation lives in the thin agent**, and within the
agent it is **isolated to `mappings/Names.java`**. Everything else (`ScreenInspector`,
`WidgetClicker`, selector matching) is written against a tiny **stable internal façade** that
`Names.java` implements per mapping set. This is the per-version tax, quarantined to one file, so M5
fan-out re-implements only that file.

### 5.3 Selector resolution (client)

- `label`/`text`/`textContains` → `ClickableWidget.getMessage().getString()` and rendered text
  elements. `role=button` → `ButtonWidget`/`PressableWidget`; `role=input` → `TextFieldWidget`;
  `role=listItem` → entries of `*ListWidget`/`EntryListWidget`.
- `testId` → a `mc-test:test_id` property our cooperating mods set on widgets (the client analog of
  the server SPI). Most robust path for mods we control.
- `screen.clickElement` synthesizes the widget's click on the client thread; `screen.waitForScreen`
  matches `Screen` class/title; `event.screenChanged` fires on screen open/close.

### 5.4 Acceptance criteria (M4 is "done" when…)

- [ ] A **mod** version of the regions example (a Fabric mod whose `/or` opens a real client `Screen`
      with a "Regions" button and a "TestRegion" entry) is driven end-to-end: `command("or")` →
      `waitForScreen` → `click({label:"Regions"})` → `click({label:"TestRegion"})` →
      `assertChat({contains:"Region loaded"})` — **passing against pixels-real client UI** that the
      headless bot provably cannot see (the same test on the headless driver **skips** with
      `unmet:["clientScreens"]`).
- [ ] `screen.screenshot` returns a valid PNG of the open screen; on failure the runner attaches it as
      an artifact. A baseline screenshot diff is wired (informational, not gating in M4).
- [ ] The client launches **headlessly under Xvfb** in Linux CI with `online-mode=false`/offline auth,
      and on a desktop CI runner natively — both selected automatically by `Display.ts`.
- [ ] `clientScreens`-requiring tests select `driver-inprocess`; `containerGui`-only tests still pick
      headless. The runner can run a **mixed suite** picking the right driver per test from one
      `mc-test.yml`.
- [ ] **All** Yarn/obfuscation references are confined to `mappings/Names.java`; a CI check (import
      scan) fails if mapped names leak into any other file.
- [ ] The client agent passes the **M1 conformance fixtures** for `screen.*`.
- [ ] A combined session works: client agent for `screen.*` **and** the M3 Bukkit agent for
      `assertPluginState` in the **same** test (client GUI proves the click; server truth proves the
      region) — the full-fidelity regions story.

### 5.5 What M4 unlocks

The only way to test **real mod client GUIs** — custom screens, HUDs, config menus — with semantic
selectors and screenshots, while still paying for a rendered client **only** on tests that truly need
it. mc-test now covers the full plugin **and** mod GUI space.

---

## 6. M5 — Fan the agent core out across loaders & versions

**Goal:** turn one client agent + one server agent into the **whole matrix** by re-implementing only
the thin, taxed shims. Add `/agents/client-forge`, `/agents/client-neoforge`, `/agents/server-fabric`,
and exercise the `(loader × version)` grid from `mc-test.yml`.

### 6.1 Scope / deliverables

```
/agents/client-forge        # thin Forge client mod: reuses /agents/core; MCP/SRG-mapped Names.java
/agents/client-neoforge     # thin NeoForge client mod: reuses /agents/core; Mojmap Names.java
/agents/server-fabric       # server-mod truth agent (Fabric/NeoForge server): truth.*, fixtures via GameTest hooks
# (Quilt rides the Fabric agent where compatible; advertised via capabilities.loader)
```

Each new agent re-implements **only**:
1. the loader entrypoint (`ClientModInitializer` / `@Mod` / `ModInitializer`), and
2. `mappings/Names.java` for that mapping set (Yarn / MCP-SRG / Mojmap).

`/agents/core` (dispatch, selector matching, element model, error codes, capability builder) is
**unchanged**.

### 6.2 The version matrix lives in `mc-test.yml`

```yaml
# mc-test.yml — the environment matrix (canonical field names)
defaults:
  online-mode: false
  worldSnapshot: ./examples/regions/world-snapshot
targets:
  - id: paper-1.20.4
    loader: paper
    mc: "1.20.4"
    driver: headless          # bot path
    plugins: [ ./examples/regions/plugin ]
    agents: [ server-bukkit ]
  - id: paper-1.8.9
    loader: paper
    mc: "1.8.9"
    driver: headless
    via: true                 # route through ViaProxy
    plugins: [ ./examples/regions/plugin ]
    agents: [ server-bukkit ]
  - id: fabric-1.21-client
    loader: fabric
    mc: "1.21"
    driver: inprocess         # rendered client
    mods: [ ./examples/regions/mod ]
    agents: [ client-fabric, server-fabric ]
    display: xvfb
  - id: neoforge-1.21-client
    loader: neoforge
    mc: "1.21"
    driver: inprocess
    mods: [ ./examples/regions/mod ]
    agents: [ client-neoforge, server-fabric ]
    display: xvfb
```

Canonical `mc-test.yml` field names (reserved): top-level `defaults`, `targets`; per-target `id`,
`loader`, `mc`, `driver`, `via`, `plugins`, `mods`, `agents`, `display`, `worldSnapshot`,
`online-mode`, `world`. `driver ∈ { headless, inprocess, pixel }`. `display ∈ { xvfb, desktop }`.

### 6.3 Acceptance criteria (M5 is "done" when…)

- [ ] The canonical regions test (GUI + `assertPluginState`) runs **green or honestly-skipped** across
      **at least**: `paper-1.20.4` (headless), `paper-1.8.9` (headless via Via), `fabric-1.21-client`
      (inprocess), `neoforge-1.21-client` (inprocess) — from **one** unchanged test file.
- [ ] Adding a new MC version to an existing loader requires editing **only** `mappings/Names.java`
      (and a `mc-test.yml` row) — proven by a PR that adds one version touching no shared core file.
- [ ] A `pixel` driver stub exists and is selectable as the documented last resort (OCR/template),
      advertising `clientScreens` only with a `brittle` flag in capabilities and a loud report note.
- [ ] The full matrix runs in CI with per-target parallelism (distinct ports + per-test world copies)
      and aggregates into one JUnit + artifacts bundle, with a clear **skip matrix** showing which
      `(test × target)` cells were skipped and **why** (capability reason strings).

### 6.4 What M5 unlocks

The headline promise: **author once, run across the whole matrix**. Versions/loaders become config
rows; new ones cost one shim file. The narrow waist has paid off.

---

## 7. "Testing the tester" strategy

A test framework that lies is worse than none. We verify mc-test at four levels; each milestone adds
its layer.

### 7.1 Protocol conformance (from M1, every driver forever)
- The **golden conformance fixtures** in `/packages/protocol/fixtures/conformance/` are the executable
  contract. Every driver/agent ships a `conformance.test.*` that boots the driver and replays each
  fixture, asserting the response validates against the schema and matches expected `reason` codes for
  error cases. A driver is not "done" until it is green here. This catches drift between an agent's
  behavior and the wire spec without any live Minecraft.

### 7.2 Mock peers on both ends (fast, no game)
- **Mock agent (runner tests):** a tiny in-repo MCTP server (`/packages/runner/test/mockAgent.ts`)
  that returns scripted responses lets us unit-test the engine — capability matching, `SelectorWaits`
  retry/timeout, step→MCTP mapping, reporter output — with **no server boot**. Includes failure
  injection (`ELEMENT_NOT_FOUND` N times then success → proves runner retries; permanent
  `AMBIGUOUS_SELECTOR` → proves it surfaces candidates).
- **Mock runner (agent tests):** the Java agents are tested with a scripted JSON-RPC client replaying
  the same fixtures, so the JVM side is verified independently of Node.

### 7.3 Golden end-to-end on the canonical example (from M2)
- `/examples/regions` is the **system test**. CI runs the real regions test on real Paper/Fabric. We
  add **negative** controls that must *fail* and *skip* as designed:
  - **Mutation test:** rename the GUI button "Regions"→"Zones" in a throwaway build → the test MUST go
    **red** with `ELEMENT_NOT_FOUND label="Regions"` (proves selectors actually bind to UI).
  - **Capability skip test:** run the `clientScreens` mod test on the headless driver → MUST report
    **skipped** `unmet:["clientScreens"]`, never pass.
  - **Truth/UI divergence test:** make the GUI *say* "Region loaded" while the server fixture creates
    **no** region → GUI half green but `assertPluginState` MUST go **red** (proves we assert real
    state, not just chat). This is the single most important "tester test."

### 7.4 Cross-driver equivalence & flake control (M3+)
- **Equivalence harness:** where a test is expressible on two drivers (e.g. a server chest GUI visible
  to both bot and client mod), run both and assert the **same** semantic outcome. Divergence is a
  driver bug, surfaced as a dedicated CI check.
- **Flake budget:** every green E2E target runs **N=3** times nightly; any nondeterministic result
  trips a flake alarm. `SelectorWaits` timeouts and provisioning races are the usual suspects and are
  logged with timing breadcrumbs (`event.log`) for triage.
- **Schema/type drift gate (from M1):** CI fails if the committed JSON Schema and the TS types diverge,
  so the contract can't rot silently.

---

## 8. Hard parts (honest register) + mitigations

These are the things that will actually hurt. Each has an owner-milestone and a concrete mitigation.

### 8.1 Obfuscation mappings (Yarn / MCP-SRG / Mojmap) — *the per-version tax*  · M4–M5
- **Why it hurts:** client/mod internals are obfuscated and remapped every MC version and differ per
  loader. Naively, every primitive would break each release.
- **Mitigations:**
  - **Quarantine:** all mapped symbols live **only** in `mappings/Names.java` behind a stable façade;
    a CI import-scan fails if mapped names leak elsewhere. Adding a version = re-implement one file.
  - **Generate, don't hand-write where possible:** use the loader's mapping artifacts (Yarn via Loom;
    NeoForge Mojmap; Forge SRG) at build time; keep a thin hand-written adapter only for the few
    runtime-reflected names.
  - **Prefer cooperating-SUT `testId` tags** (§2.5/§5.3) so the most important selections don't depend
    on mapped widget internals at all.
  - **Server agent dodges this entirely** (M3 uses the stable Bukkit API) — which is exactly why M3 is
    sequenced before M4 to bank value early.

### 8.2 Headless rendering of a real client  · M4
- **Why it hurts:** the client needs a GL context; CI is headless; GPU drivers vary.
- **Mitigations:**
  - **Xvfb + software GL (Mesa/llvmpipe)** as the default Linux CI path; `Display.ts` auto-selects
    Xvfb vs. native desktop. Pin a known-good Mesa in the Docker image for reproducibility.
  - **Screenshots are diagnostic, not load-bearing:** selectors use the widget tree, not pixels, so a
    flaky framebuffer doesn't fail logic tests — only the (informational) screenshot diff.
  - **A desktop CI runner** (or self-hosted machine with a real GPU) is the supported fallback for
    versions/drivers that misbehave under llvmpipe; advertised per target via `display: desktop`.
  - **Boot timeouts & readiness probes:** wait on `event.screenChanged`/log markers, never fixed
    sleeps, to tame slow first-frame startup.

### 8.3 Authentication / online-mode  · M2 (and everywhere)
- **Why it hurts:** real Microsoft/Mojang auth is interactive and unsuitable for CI; sessions expire.
- **Mitigations:**
  - **`online-mode=false` by default** for all provisioned servers (it's a closed test loop on
    loopback/private network). Headless bot and rendered client both join offline; usernames are
    deterministic (`Tester`, `Bot2`).
  - **No Microsoft auth path in CI at all.** If a future scenario needs online-mode (e.g. testing the
    auth flow itself), it is an **opt-in** target with injected service-account credentials from CI
    secrets, isolated and clearly marked — never the default.
  - **Encapsulation/whitelist** the test network so offline mode is safe (bind loopback, ephemeral
    ports, per-test world copies).

### 8.4 Very old protocol versions (MC 1.8 ↔ modern)  · M2, M5
- **Why it hurts:** the wire protocol changed drastically; a single bot can't speak every version; old
  versions have quirky GUIs and packet semantics.
- **Mitigations:**
  - **ViaVersion/ViaProxy** in front of the headless driver (`via: true` in `mc-test.yml`) to bridge a
    modern Mineflayer to old servers; `minecraft-data` supplies per-version block/item/window data so
    selector resolution stays version-correct.
  - **Capability honesty:** if Via cannot faithfully bridge a given version/feature, the driver
    **narrows `mcVersionRange`** and the runner **skips** the unsupported cell with a precise reason
    rather than producing a dubious pass. The skip matrix (§6.3) makes coverage gaps visible instead of
    hidden.
  - **Pin Via/Mineflayer/minecraft-data versions** per target so old-version behavior is reproducible;
    treat a Via upgrade as a matrix change gated by the golden E2E.

### 8.5 GUI timing, animation, and async server pushes  · M2+
- **Why it hurts:** GUIs open a tick late; chest contents arrive in packets after the window opens;
  client screens animate.
- **Mitigations:** all selector steps run through **`SelectorWaits`** (runner-side poll/retry with
  `timeoutMs`); `waitForScreen`/`waitForChat`/`event.screenChanged` are event-driven, not sleep-based;
  agents return a fresh `ScreenSnapshot` per call so the runner always polls current truth.

### 8.6 Cross-process session orchestration  · M3+
- **Why it hurts:** a single test may span a headless driver **and** one or two JVM agents, each its
  own MCTP server, with independent lifecycles and ports.
- **Mitigations:** the runner's `Session` owns N connections keyed by advertised capability and fans
  each step to the right one; provisioning assigns disjoint ports and a private world copy per test for
  parallelism; teardown is ordered (driver leave → agent close → server stop) with `event.disconnected`
  used to detect crashes and fail fast with logs attached.

### 8.7 Generic plugin-state assertions without per-plugin code  · M3
- **Why it hurts:** we can't ship knowledge of every plugin's internals.
- **Mitigations:** the two-layer probe (§4.3) — best-effort reflective/Services query for arbitrary
  plugins, plus an **opt-in `McTestStateProvider` SPI** (and GUI-side `testId` tags) for SUTs we
  control. When neither can answer, return `ASSERT_FAILED` with an explanatory reason — **never a
  silent pass**.

---

## 9. Cross-cutting definition of done (applies to M2–M5)

Every milestone that ships runnable code must also satisfy:

> **M3 status note (2026-06-15).** For M3 these are met as follows. The **negative controls** (a
> designed red and a designed skip) and **capability-driven selection** are proven with no boot by
> the runner M3 tests — the truth/UI **divergence** test (chat says loaded but `regions.exists`
> false → red on `assertPluginState`, §7.3) and the **honest skip** (no agent → `assertPluginState`
> skipped `unmet:["pluginState"]`) run against the mock server agent. The **conformance** box is
> proven by the now-green `/agents` build (core `ConformanceTest`). **Reproducible provisioning** of the
> server agent (jar in `plugins/`, second MCTP port via `plugins/mc-test-agent/config.yml`, port
> learned from the `MCTP listening on :PORT` log) is specified in `ENVIRONMENTS.md` §2.4.1 and
> wired in the runner provisioner; the live-boot exercise is acceptance-only here. **Docs** are
> synced (this change) and each new agent dir ships a `README.md`. Boxes left unticked are gated on
> the integration build/boot, not on missing design.

- [x] Green against the **M1 conformance fixtures** for all advertised methods. *(Core `ConformanceTest`
      replays the M1 fixtures against a real `MctpServer` — `gradle :core:test` green.)*
- [x] At least one **negative control** wired into CI (a designed red and a designed skip) per §7.3.
      *(Proven by the runner M3 mock-agent tests — divergence→red and no-agent→skip — with no boot.)*
- [ ] JUnit XML + on-failure artifacts (logs always; screenshot when `screenshot` is advertised).
      *(Inherited unchanged from the M2 reporter; not re-exercised for the multi-connection path here.)*
- [x] Capability-driven selection only — **no hard-coded driver/agent choice** in the engine.
      *(M3 routes server-owned steps to the agent purely by advertised capability via `SessionGroup`;
      a transport-unreachable or refusing agent drops out of the union and its steps honestly skip.)*
- [ ] Reproducible provisioning: pinned jars/mappings, `online-mode=false`, per-test world snapshot,
      ephemeral ports, parallel-safe. *(Server-agent provisioning (jar + second MCTP port + readiness
      gate on the `MCTP listening on :PORT` log) is wired in the runner provisioner; the live-boot
      exercise is acceptance-only here.)*
- [x] Docs: a `README.md` in the package/agent dir showing how to run the canonical regions example
      against it. *(Docs synced this change; `/agents/core` and `/agents/server-bukkit` ship READMEs.)*

---

## 10. Name index (the canonical names this roadmap uses)

For convenience, the canonical names this roadmap uses — all **defined in `PROTOCOL.md`** (the single
source of truth for the wire contract), which this roadmap defers to — are:

- **Packages/paths:** `/packages/protocol` (`@mc-test/protocol`), `/packages/runner`
  (`@mc-test/runner`, bin `mc-test`), `/packages/driver-headless` (`@mc-test/driver-headless`),
  `/packages/driver-inprocess` (`@mc-test/driver-inprocess`), `/agents/core`, `/agents/server-bukkit`,
  `/agents/server-fabric`, `/agents/client-fabric`, `/agents/client-forge`, `/agents/client-neoforge`,
  `/examples/regions`, `mc-test.yml`.
- **MCTP methods:** `session.create`, `session.describe`, `session.close`, `session.ping`;
  `world.join`, `world.leave`, `world.sendChat`, `world.runCommand`, `world.waitForChat`;
  `screen.get`, `screen.listElements`, `screen.clickElement`, `screen.typeText`, `screen.pressKey`,
  `screen.screenshot`, `screen.waitForScreen`, `screen.close`; `truth.getWorldBlock`,
  `truth.getEntities`, `truth.assertPluginState`; `fixture.set`, `fixture.reset`; `player.spawnFake`,
  `player.despawnFake`.
- **MCTP notifications:** `event.chat`, `event.screenChanged`, `event.log`, `event.disconnected`.
- **Agent primitive verbs (SDK form):** `listElements`, `clickElement`, `getScreen`, `typeText`,
  `pressKey`, `screenshot`, `getWorldBlock`, `getEntities`, `setFixture`, `spawnFakePlayer`,
  `assertPluginState`.
- **Capability keys:** `chat`, `command`, `containerGui`, `clientScreens`, `screenshot`, `rendering`,
  `worldTruth`, `pluginState`, `fixtures`, `fakePlayers`, `typeText`, `pressKey`, `testIdTags`,
  `loader`, `mcVersionRange`.
- **Selector keys:** `label`, `text`, `textContains`, `loreContains`, `itemType`, `role`, `index`,
  `nth`, `within`, `testId`.
- **Selector roles:** `button`, `slot`, `label`, `input`, `tab`, `list`, `listItem`.
- **Error reasons:** `ELEMENT_NOT_FOUND`, `AMBIGUOUS_SELECTOR`, `METHOD_NOT_SUPPORTED`, `TIMEOUT`,
  `WORLD_NOT_READY`, `FIXTURE_FAILED`, `ASSERT_FAILED`, `PROTOCOL_VERSION_UNSUPPORTED`,
  `NO_COMPATIBLE_DRIVER`.
- **Step verbs (authoring):** `join`, `leave`, `chat`, `command`, `waitForChat`, `assertChat`,
  `waitForScreen`, `listElements`, `click`, `type`, `press`, `screenshot`, `getBlock`, `getEntities`,
  `assertPluginState`, `fixture`, `spawnFakePlayer`.
- **`mc-test.yml` fields:** `defaults`, `targets`, `id`, `loader`, `mc`, `driver`, `via`, `plugins`,
  `mods`, `agents`, `display`, `worldSnapshot`, `online-mode`, `world`; `driver ∈ {headless,
  inprocess, pixel}`; `display ∈ {xvfb, desktop}`; `loader ∈ {spigot, paper, folia, fabric, forge,
  neoforge, quilt, vanilla}`.
- **SPIs / tags:** `McTestStateProvider` (Bukkit service interface, in `/agents/core`); test-id tags
  `mctp:testId` (NBT) / `mc-test:test_id` (data component / client widget property).
- **Step-file extension:** `*.mctest.yml`.
- **Milestones:** `M1` (protocol), `M2` (runner + driver-headless), `M3` (server-bukkit),
  `M4` (client-fabric + driver-inprocess), `M5` (fan-out).
