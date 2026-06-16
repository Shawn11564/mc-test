# MCTP Capabilities & Negotiation

**Status:** Normative. This document is authoritative for capability **semantics** — the capability **registry**, the **driver × capability matrix**, the **driver cost order**, the **capability-negotiation handshake**, the **skip-with-reason** outcome shapes (including their JUnit XML representation), and how a test **declares its required capabilities** (in YAML front-matter and in the fluent API). It **uses** the capability **keys**, primitive **method names**, and **error codes** defined in `docs/PROTOCOL.md` and **defers their definition** to it; `PROTOCOL.md` is the single source of truth for those wire spellings.

Sibling docs and how they relate:
- `docs/PROTOCOL.md` — the MCTP wire contract (JSON-RPC 2.0 over WebSocket) and the **single source of truth** for capability keys, primitive method names, the error model, and the protocol version. Every capability key, method name, and error code used here is the exact string defined there. See [§13 Cross-doc contract](#13-cross-doc-contract).
- `docs/DRIVERS.md` — the four drivers and which capabilities each advertises. The matrix in [§4](#4-driver--capability-matrix) is authoritative for the per-driver capability sets (using PROTOCOL's keys) and `DRIVERS.md` references it.

Audience: runner authors (`/packages/runner`), driver authors (`/packages/driver-headless`, `/packages/driver-inprocess`), agent authors (`/agents/*`), and test authors (`/tests`, `/examples`).

The running example throughout is the canonical **regions** target: a plugin/mod where the command `/or` opens a GUI with a **Regions** button that leads to entries like **TestRegion**. The reference test is:

> join `localhost` → `/or` → click **Regions** → click **TestRegion** → assert chat contains `"Region loaded"` **AND** (via the server agent) region `"TestRegion"` exists.

---

## Table of contents

1. [Why capabilities exist](#1-why-capabilities-exist)
2. [Capability model & vocabulary](#2-capability-model--vocabulary)
3. [Canonical capability keys](#3-canonical-capability-keys)
4. [Driver × capability matrix](#4-driver--capability-matrix)
5. [Capability → primitive mapping](#5-capability--primitive-mapping)
6. [The negotiation handshake](#6-the-negotiation-handshake)
7. [Driver selection algorithm](#7-driver-selection-algorithm)
8. [Skip-with-reason semantics](#8-skip-with-reason-semantics)
9. [Skips in JUnit XML reports](#9-skips-in-junit-xml-reports)
10. [Declaring required capabilities — YAML front-matter](#10-declaring-required-capabilities--yaml-front-matter)
11. [Declaring required capabilities — fluent API](#11-declaring-required-capabilities--fluent-api)
12. [End-to-end: the regions test, negotiated](#12-end-to-end-the-regions-test-negotiated)
13. [Cross-doc contract](#13-cross-doc-contract)

---

## 1. Why capabilities exist

`mc-test` runs **one** semantic test across a large matrix of `{loader, mc, driver, world, plugins/mods}` targets. Not every target can do everything:

- A **headless protocol bot** can send `/or` and read the resulting **inventory GUI**, but it cannot see a **client-rendered mod Screen** and cannot take a meaningful **screenshot** of one.
- An **in-process client agent** can drive a real client **Screen**, render it, and screenshot it — but paying for a rendered client is slow and is wasted on a pure plugin test.
- A **server-side agent** owns **world-truth** and **plugin-state** assertions and can create **fake players** and **fixtures**, but it has no client UI at all.

Capabilities are the **Appium-style contract** that makes this tractable: each driver **advertises** what it can do, each test **declares** what it **requires**, and the runner **picks a compatible driver per target** or **skips with a precise, human-readable reason**. This keeps the [PRIME DIRECTIVES](#) intact:

- **Protocol-first** — capabilities are negotiated over MCTP; the runner never special-cases a backend.
- **Tiny dumb agents** — capabilities describe *primitives*, never selectors/assertions/retries (those live in the runner).
- **Semantic selectors** — capabilities gate *which selector resolvers* are reachable (e.g. `clientScreens` enables widget resolution; `containerGui` enables slot/display-name resolution).
- **Fast in CI** — declaring the minimum capability set lets the runner choose the cheapest compatible driver (headless over rendered client whenever possible).

---

## 2. Capability model & vocabulary

A **capability key** is a stable, camelCase string (e.g. `containerGui`). It names a coherent bundle of behavior backed by one or more MCTP **primitives**.

Three distinct sets of keys flow through a session:

| Term | Who produces it | Meaning |
| --- | --- | --- |
| **Advertised capabilities** | a **driver** (and, transitively, the agent it speaks to) | The full set the driver *can* provide for a given target. Returned from `driver.describe()` and surfaced over MCTP via `session.describe` (see [PROTOCOL.md]). |
| **Required capabilities** | a **test** (YAML front-matter `requires:` or fluent `.requires(...)`) | The set the test *must* have, or it cannot run meaningfully. Missing → **skip**. |
| **Negotiated (granted) capabilities** | the **runner**, at session create | The intersection actually activated for this session: `granted = required ⊆ advertised`. Returned in the `session.create` result as `capabilities`. |

Rules:

- **Keys are closed.** The valid set is the capability-key list **defined in `PROTOCOL.md`** and registered in the JSON Schema in `/packages/protocol`; [§3](#3-canonical-capability-keys) mirrors the subset this doc gives semantics to. An unknown key in `requires:` is a **configuration error** (fail the test as `error`, not `skipped` — see [§8](#8-skip-with-reason-semantics)). An unknown key in a driver's advertisement is **ignored with a warning** (forward-compat for newer agents talking to older runners).
- **Capabilities are not levels.** There is no ordering; `rendering` does not "imply" `screenshot`. If a test needs both, it lists both. (Implication shortcuts that *are* allowed are spelled out per key in [§3](#3-canonical-capability-keys) and are purely advisory bundles, never silent grants.)
- **A capability is boolean per session**, but may carry **detail** in the advertisement (e.g. `screenshot` advertises `{ format: ["png"], maxWidth: 1920 }`). Detail is informational for reporting; selection matches on presence of the key only.
- **Optional capabilities** (`optional:` / `.optional(...)`) never cause a skip; they are granted if available and let the test branch on `ctx.has("...")` at runtime.

---

## 3. Canonical capability keys

The capability keys are **defined in `PROTOCOL.md`** (the single source of truth) and encoded in the JSON Schema in `/packages/protocol`; the spellings below mirror them verbatim. The table gives the **semantics** of each key — its meaning, backing MCTP primitives, and advertisement detail — which is this doc's authoritative concern.

> `PROTOCOL.md` additionally registers the keys `typeText`, `pressKey`, and `testIdTags`. For **capability gating and driver selection**, this doc folds `typeText`/`pressKey` into `clientScreens` (the surface that backs them) and treats `testIdTags` as a selector concern (see `SELECTORS.md`); they are therefore not listed as separate rows in the selection registry below. Their wire definition still lives in `PROTOCOL.md`.

| Key | One-line meaning | Backing MCTP primitives | Advertisement detail (optional) |
| --- | --- | --- | --- |
| `command` | Run a slash command / console-style command as the session actor. | `world.runCommand` | `{ console: bool }` — also able to run server-console commands, not just player chat-commands. |
| `chat` | Send chat and observe inbound chat/system messages. | `world.sendChat`, `world.waitForChat` (+ `event.chat` notification) | `{ system: bool }` — system/action-bar lines are captured too. |
| `containerGui` | Read & interact with a **server-driven container GUI** (chest/anvil/hopper menus). | `screen.listElements`, `screen.clickElement`, `screen.get` | `{ containerTypes: string[] }` |
| `clientScreens` | Read & interact with a **client-rendered Screen** (real mod GUI: `Screen`/`ClickableWidget`). | `screen.listElements`, `screen.clickElement`, `screen.get`, `screen.typeText`, `screen.pressKey` | `{ widgetRoles: string[] }` |
| `rendering` | A live rendering pipeline exists (a real framebuffer is being drawn). Prerequisite for visual checks. | *(none directly; gates `screenshot` quality and pixel selectors)* | `{ headless: bool, display: "xvfb"｜"desktop" }` |
| `screenshot` | Capture an image artifact of the current screen/region. | `screen.screenshot` | `{ format: string[], maxWidth: int, maxHeight: int }` |
| `worldTruth` | Read authoritative server world state (blocks, entities). | `truth.getWorldBlock`, `truth.getEntities` | `{ dimensions: string[] }` |
| `pluginState` | Assert against authoritative plugin/mod runtime state on the server. | `truth.assertPluginState` | `{ namespaces: string[] }` — e.g. `["regions"]`. |
| `fixtures` | Deterministically set up/tear down world & plugin state before steps. | `fixture.set` | `{ kinds: string[] }` — e.g. `["region", "block", "inventory"]`. |
| `fakePlayers` | Spawn/despawn server-side fake players to drive multi-actor scenarios. | `player.spawnFake`, `player.despawnFake` | `{ max: int, engine: "carpet"｜"native" }` |

Notes per key:

- **`command` vs `chat`.** `/or` requires `command`. Asserting that the response line `"Region loaded"` appeared requires `chat` (specifically inbound capture via `world.waitForChat`). The regions test therefore requires **both**.
- **`containerGui` vs `clientScreens`.** Both back the same three read/interact primitives (`screen.listElements`, `screen.clickElement`, `screen.get`) so a selector like `screen.clickElement(label "Regions")` is *written once*; the **driver** decides whether "Regions" resolves to a container slot's display-name (`containerGui`) or a widget's `getMessage()` (`clientScreens`). A test that must run on either declares **one** of them via an `anyOf` group (see [§10](#10-declaring-required-capabilities--yaml-front-matter)). `screen.typeText`/`screen.pressKey` are only guaranteed under `clientScreens` (text fields in real Screens); container menus expose only click.
- **`rendering` is a prerequisite, not a payload.** It asserts pixels are actually being drawn. `screenshot` without `rendering` is allowed (an agent may grab a logical/last-known buffer) but such an image is flagged `rendered:false` in the artifact manifest. Pixel/OCR selectors (`role: "pixel"`, template/OCR resolution) require **both** `rendering` and `screenshot`.
- **`worldTruth` and `pluginState` are independent.** "Region TestRegion exists" is a `pluginState` assertion in namespace `regions`. "Block at (10,64,10) is `minecraft:beacon`" is `worldTruth`. The regions test uses `pluginState`; many tests use neither.
- **`fixtures` and `fakePlayers` are setup capabilities**, evaluated the same way as interaction capabilities but typically required by the test *prelude* (`setup:` / `.fixture(...)`), not the assertions.

---

## 4. Driver × capability matrix

This matrix is **authoritative**. `DRIVERS.md` describes each driver in prose and links here; the JSON Schema in `/packages/protocol` encodes the same per-driver default advertisement.

Legend: **✅ yes (always advertised)** · **⚠️ conditional (advertised only when the target/runtime supports it — see footnote)** · **❌ no (never advertised)**.

| Capability ↓  \  Driver → | `headless`<br>(Mineflayer) | `inprocess`<br>(client mod agent) | `server`<br>(Bukkit/Paper + server-mod) | `pixel`<br>(OCR/template) |
| --- | :---: | :---: | :---: | :---: |
| `command` | ✅ | ✅ | ✅ | ❌ |
| `chat` | ✅ | ✅ | ✅ | ❌ |
| `containerGui` | ✅ | ✅ | ❌ | ❌ |
| `clientScreens` | ❌ | ✅ | ❌ | ⚠️ ¹ |
| `rendering` | ❌ | ⚠️ ² | ❌ | ✅ |
| `screenshot` | ❌ | ⚠️ ² | ❌ | ✅ |
| `worldTruth` | ⚠️ ³ | ⚠️ ⁴ | ✅ | ❌ |
| `pluginState` | ❌ | ❌ | ✅ | ❌ |
| `fixtures` | ❌ | ❌ | ✅ | ❌ |
| `fakePlayers` | ❌ | ❌ | ⚠️ ⁵ | ❌ |

Footnotes (conditions under which a ⚠️ becomes ✅ for that target):

1. **`pixel` + `clientScreens`** — the pixel driver advertises `clientScreens` only in a *degraded* form: it can `screen.clickElement` by OCR/template match and `screen.get` returns OCR-derived text elements, but `screen.listElements` fidelity is best-effort and `screen.typeText`/`screen.pressKey` go through synthetic key events. It is the universal last resort; selection prefers any other driver that satisfies the same requirement (see [§7](#7-driver-selection-algorithm) cost ordering).

> **Pixel driver status (M5): shipped as a selectable stub.** The pixel column above is no longer hypothetical — the driver exists as the package `@mc-test/driver-pixel` (`/packages/driver-pixel`, driver id `pixel`, MCTP `agent.kind: pixelOcr`), registered in the runner's `DriverRegistry` at **cost 4** (the last resort, per [§7](#7-driver-selection-algorithm)). The implemented stub **advertises** the boolean set `chat, command, containerGui, clientScreens, screenshot, rendering, typeText, pressKey` (plus all loaders and `mcVersionRange: ">=1.8"`) and additionally surfaces the advisory **`brittle`** descriptor (see the note below). It does **not** advertise `testIdTags`, `worldTruth`, `pluginState`, `fixtures`, or `fakePlayers`. The OCR/template + OS-input backend is **not implemented**: the driver is registered purely so capability negotiation can reason about it, and `start()` throws `PixelDriverNotImplementedError` — selection never *launches* it. Selection still prefers any cheaper structural driver; `pixel` is chosen only when nothing cheaper fits (or `driver: pixel` is pinned), so the stub is never actually started by the normal regions targets.

> **The `brittle` advisory descriptor.** `brittle` is an **advisory quality descriptor** that the pixel/OCR driver advertises as `brittle: true` (its spelling and semantics are owned by `PROTOCOL.md`, which carries it on the protocol `Capabilities` object alongside `loader`/`mcVersionRange`). It is **deliberately excluded from the canonical capability-key set** — `brittle` is **not** a matchable capability, exactly like the `loader` and `mcVersionRange` *target descriptors*: a test can never `requires:` or `optional:` it, and it never participates in `satisfies(union, R)`. The runner reads it for **reporting only**: when a `brittle: true` driver is selected it emits a loud report note (console + a JUnit `<property name="brittle" value="true"/>`, see [§9](#9-skips-in-junit-xml-reports)). It is therefore omitted from the capability-key registry in [§3](#3-canonical-capability-keys) and [§13.1](#131-capability-keys-semantics-registry--spellings-defined-in-protocolmd) on purpose.
2. **`inprocess` + `rendering`/`screenshot`** — advertised when the client agent is attached to a client with a live framebuffer (desktop CI runner or Linux under **Xvfb**). A headless/integrated-server client without a display advertises `clientScreens` but **not** `rendering`/`screenshot`.
3. **`headless` + `worldTruth`** — the Mineflayer bot only has client-side world knowledge (loaded chunks around it). It advertises `worldTruth` **only when paired with the server agent in the same session** (co-driver), so authoritative reads go through `truth.getWorldBlock`/`truth.getEntities` on the server. Standalone, it does **not** advertise `worldTruth`.
4. **`inprocess` + `worldTruth`** — same rule as headless: advertised only when co-driven by the server agent. The client agent never asserts world-truth on its own.
5. **`server` + `fakePlayers`** — advertised when a fake-player engine is present: **Carpet** (`engine:"carpet"`) on Fabric server targets, or the native fake-player shim in the server-mod variant. A bare Bukkit/Paper server without the engine advertises everything else but **not** `fakePlayers`.

**Co-driver rule (multi-driver sessions).** `worldTruth`, `pluginState`, `fixtures`, and `fakePlayers` are **server-owned**. A primarily client-facing test (using `inprocess` or `headless` for UI) gets these by attaching the **`server` driver as a co-driver** in the same session. The runner does this automatically when the required set spans both UI and server-owned capabilities (see [§6](#6-the-negotiation-handshake) and [§7](#7-driver-selection-algorithm)). The advertised set the runner reasons about is the **union** of the primary driver's and the co-driver's advertisements.

**Server-agent fan-out (M3, `server-bukkit`).** The first concrete co-driver is the Bukkit plugin agent `/agents/server-bukkit` (MCTP `agent.kind: serverPlugin`), which advertises exactly `worldTruth, pluginState, fixtures, fakePlayers, chat, testIdTags`. The runner opens it as a **second MCTP connection** (its own port) alongside the UI driver and merges its advertised caps into the **union** above. Per-step routing follows the gating capability: a step that requires `worldTruth`/`pluginState`/`fixtures`/`fakePlayers` is **fanned to the server-agent connection**; UI/chat steps stay on the primary driver connection — the test author writes no connection plumbing. When **no** server agent is co-selected for a target, those server-owned requirements are unmet, so the step is reported **`skipped` with `NO_COMPATIBLE_DRIVER` carrying `unmet:[…]`** (e.g. `unmet:["pluginState"]`) — an honest skip, never a false pass. This is exactly the M2→M3 transition: the canonical regions `assertPluginState` step **skips** until the `server-bukkit` agent is built and co-selected, then **runs green** against real plugin state.

**Client-agent driver (M4, `inprocess`).** As of **M4** the `inprocess` driver (the client-mod agent, `agent.kind: clientMod`, served by `/packages/driver-inprocess` + `/agents/client-fabric`) is a **registered, selectable driver** in the runner's `DriverRegistry` at **cost 3** (between `headless` and `pixel`, per the cost order in [§7](#7-driver-selection-algorithm)). It advertises the `inprocess` column of the matrix in [§4](#4-driver--capability-matrix) (`command, chat, containerGui, clientScreens, typeText, pressKey, testIdTags`, plus `rendering`/`screenshot` when a framebuffer is present). The runner therefore picks `inprocess` for a `clientScreens` test and `headless` for a `containerGui` test from one matrix — and **honestly skips** a `clientScreens` test (`unmet:["clientScreens"]`) when only `headless` is available. The `anyOf` rule for the three shared screen-read primitives ([§5](#5-capability--primitive-mapping): `screen.listElements`/`screen.clickElement`/`screen.get` gated by `containerGui`**|**`clientScreens`) is **implemented in the runner** as a verb-level capability requirement: the per-step router and the per-step skip check are `anyOf`-aware, so the *same* `click`/`waitForScreen`/`listElements` step routes to whichever co-selected connection advertises **either** surface (a connection advertising only `clientScreens` still owns the step). This is the §7 `anyOf` expansion realized at step-routing granularity — author once, the runner routes per granted surface.

---

## 5. Capability → primitive mapping

The MCTP primitives are **the only** methods an agent exposes (PRIME DIRECTIVE: tiny dumb agents). Each requires its gating capability to be in the session's **granted** set; calling a primitive whose capability was not granted is a protocol error `-32002 METHOD_NOT_SUPPORTED` (see `PROTOCOL.md` error table — `PROTOCOL.md` is the source of truth for all error codes).

| Primitive (MCTP method) | Gating capability | Notes |
| --- | --- | --- |
| `world.runCommand` | `command` | Runs `/or` etc. as the session actor. |
| `world.sendChat` | `chat` | Outbound chat. |
| `world.waitForChat` | `chat` | Inbound chat/system wait — blocks until a predicate matches (assert `"Region loaded"`); recent lines also arrive via `event.chat`. |
| `screen.listElements` | `containerGui` **or** `clientScreens` | Enumerates selectable elements of the current screen. |
| `screen.clickElement` | `containerGui` **or** `clientScreens` | Resolves a **semantic selector** and clicks it. |
| `screen.get` | `containerGui` **or** `clientScreens` | Returns current screen descriptor (id/title + element tree). |
| `screen.typeText` | `clientScreens` | Guaranteed only on real client text fields. |
| `screen.pressKey` | `clientScreens` | Synthetic key press into focused widget. |
| `screen.screenshot` | `screenshot` | Image artifact; quality flagged by `rendering`. |
| `truth.getWorldBlock` | `worldTruth` | Authoritative block read. |
| `truth.getEntities` | `worldTruth` | Authoritative entity query. |
| `truth.assertPluginState` | `pluginState` | e.g. region `TestRegion` exists in namespace `regions`. |
| `fixture.set` | `fixtures` | Deterministic pre-state. |
| `player.spawnFake` | `fakePlayers` | Multi-actor; despawn via the paired `player.despawnFake` primitive. |

> The mapping is **exactly** the table in `PROTOCOL.md §"Method ↔ capability"`. `PROTOCOL.md` is the single source of truth for both the method names and which capability gates each method; this table mirrors it and **defers** to it if they ever disagree. They are kept identical on purpose.

---

## 6. The negotiation handshake

Negotiation happens **per target, per test**, when the runner opens an MCTP session. It is a three-step exchange over the WebSocket transport defined in `PROTOCOL.md`.

```
Runner                           Driver (→ its agent over MCTP)
  │                                  │
  │ 1. describe                      │
  │ ───────────────────────────────▶│   driver.describe()  / MCTP "session.describe"
  │                                  │   probes the live target
  │ ◀─────────────────────────────── │   { driver, advertised: [...], detail: {...} }
  │                                  │
  │ 2. session.create                │
  │    { required:[...],             │
  │      optional:[...],             │   validates required ⊆ advertised
  │      actor:{...} }               │   if not satisfiable → JSON-RPC error -32002
  │ ───────────────────────────────▶│        METHOD_NOT_SUPPORTED { unmet:[...] }
  │ ◀─────────────────────────────── │   { sessionId, capabilities:{ granted:[...],
  │                                  │       optionalGranted:[...], detail:{...} } }
  │                                  │
  │ 3. primitives (screen.*, world.*, …)│
  │ ───────────────────────────────▶│   each gated by granted set
  │ ◀─────────────────────────────── │
```

Step-by-step contract:

1. **`describe`** — The runner calls the driver's `describe()` (which the driver implements by issuing the MCTP `session.describe` request to its agent, or by static knowledge for drivers like `pixel`). Returns:
   ```jsonc
   {
     "driver": "headless",
     "advertised": ["command", "chat", "containerGui"],
     "detail": {
       "chat": { "system": true },
       "containerGui": { "containerTypes": ["minecraft:chest", "minecraft:hopper"] }
     },
     "target": { "loader": "paper", "mc": "1.21.4" }
   }
   ```
   `describe` is **cheap and side-effect-free** (no world mutation, no fixtures). The runner may cache it per `(driver, target)` for the duration of a matrix run.

2. **`session.create`** — The runner sends the test's **required** and **optional** sets:
   ```jsonc
   { "jsonrpc": "2.0", "id": 1, "method": "session.create",
     "params": {
       "required": ["command", "chat", "containerGui"],
       "optional": ["screenshot"],
       "actor": { "username": "mc-test-bot" }
     } }
   ```
   The driver/agent computes `unmet = required − advertised`.
   - If `unmet` is empty → success result:
     ```jsonc
     { "jsonrpc": "2.0", "id": 1, "result": {
         "sessionId": "s_7f3a",
         "capabilities": {
           "granted": ["command", "chat", "containerGui"],
           "optionalGranted": [],                 // screenshot not available on headless
           "detail": { "containerGui": { "containerTypes": ["minecraft:chest"] } }
         } } }
     ```
   - If `unmet` is non-empty → **error** (not a result):
     ```jsonc
     { "jsonrpc": "2.0", "id": 1, "error": {
         "code": -32002, "message": "METHOD_NOT_SUPPORTED",
         "data": { "unmet": ["clientScreens"], "advertised": ["command","chat","containerGui"] } } }
     ```
   The runner treats this `-32002` (the target's drivers lack the capability) as the trigger for a **skip-with-reason** carrying runner-level reason `NO_COMPATIBLE_DRIVER` (see [§8](#8-skip-with-reason-semantics)), **not** a test failure.

3. **Primitives** — Once a session exists, the runner issues primitives. Any primitive whose gating capability is absent from `granted` returns `-32002 METHOD_NOT_SUPPORTED`; when it occurs *after* a successful negotiation this is a **runner bug** (it should have required the capability) and surfaces as test `error`, never `skipped`.

**Multi-driver / co-driver negotiation.** When the runner determines (from selection, [§7](#7-driver-selection-algorithm)) that it needs a primary UI driver plus the server co-driver, it opens **one logical session** that fans out to two MCTP endpoints. `session.create` is sent to each; the runner requires the *partition* of capabilities each endpoint owns (UI caps to the primary, server-owned caps to the co-driver). The session's `granted` is the union. If **either** endpoint returns `-32002` for its partition, the whole session is unsatisfiable → skip (`NO_COMPATIBLE_DRIVER`).

---

## 7. Driver selection algorithm

The runner picks **one** primary driver (plus an optional server co-driver) per `(test, target)`. The matrix file `mc-test.yml` may pin a driver per target; if pinned, selection only **validates** that pin against requirements (and skips if the pin can't satisfy them). If not pinned, the runner chooses.

**Inputs**
- `R` = test required capabilities (after expanding `anyOf` groups — see below).
- `O` = test optional capabilities.
- `A_d` = advertised capabilities of driver `d` for this target (from `describe`, union with server co-driver where applicable).
- `pin` = `target.driver` from `mc-test.yml`, or unset.

**Cost ordering (cheapest first).** Prefer the least expensive driver that satisfies `R`:

```
1. server      # no client, no bot — pure server-side; fastest
2. headless    # Mineflayer bot; no rendered client
3. inprocess   # real client, optionally rendered; slow
4. pixel       # OCR/template last resort; brittle, slowest
```

(`server` is cheapest but only satisfies server-owned + chat requirements; most UI tests fall to `headless` or `inprocess`.)

The `server` tier is the in-server agent (`/agents/server-bukkit`, MCTP `agent.kind: serverPlugin`; the Fabric server-mod variant is `serverMod`). It is the cheapest tier because it pays for **no** bot login and **no** rendered client. In practice it is almost always selected as a **co-driver** in the union with a UI primary (`headless`/`inprocess`) rather than alone: it answers the server-owned caps while the primary answers the UI caps. Selecting it stand-alone is reserved for pure server-state tests (no GUI/chat-UI steps).

**`anyOf` expansion.** A requirement group like `anyOf: [containerGui, clientScreens]` is satisfied if a candidate advertises **at least one** member. The runner expands each group against each candidate independently, so the *same* test can resolve to `containerGui` on `headless` for a plugin target and to `clientScreens` on `inprocess` for a mod target — author once, run everywhere.

**Algorithm**

```text
function selectDriver(test, target):
    R := expandAnyOf(test.requires)        # set of concrete-or-group requirements
    O := test.optional

    candidates := (pin ? [pin] : [server, headless, inprocess, pixel])   # cost order
    serverCo   := describe(server, target)                               # may be unavailable

    for d in candidates:                    # in cost order
        Ad := describe(d, target).advertised
        # attach server co-driver if any required cap is server-owned and d isn't server
        needsServer := R ∩ {worldTruth, pluginState, fixtures, fakePlayers} ≠ ∅
        union := needsServer && d != server && serverCo? ? (Ad ∪ serverCo.advertised) : Ad

        if satisfies(union, R):             # every req (group) covered by union
            grantedOpt := O ∩ union
            return Session(primary=d,
                           coDriver = (needsServer && d != server ? server : none),
                           granted = neededSubset(union, R) ∪ grantedOpt)

    # nothing satisfied →
    return Skip(reason = "NO_COMPATIBLE_DRIVER", detail = explainUnmet(R, bestCandidate, target))
```

- **Determinism.** With no pin, the first driver in cost order that satisfies `R` wins; ties cannot occur because the order is total. The choice is recorded in the report (`<property name="driver">`) so reruns are explainable.
- **`explainUnmet`** computes, for the *most capable* candidate that still failed, the exact `unmet = R − union` set and renders the skip reason string in [§8](#8-skip-with-reason-semantics).
- **Pinned-but-unsatisfiable** is a **skip**, not an error: the matrix legitimately includes targets a given test can't run on (that's the point of the matrix).

---

## 8. Skip-with-reason semantics

A **skip** means: *this test could not run on this target because the target's drivers cannot provide the required capabilities (or a prerequisite was unmet).* A skip is **not** a pass and **not** a failure — it is a first-class, **reasoned** outcome that always carries a machine- and human-readable explanation.

### 8.1 What causes a skip

| Trigger | Source | Reason category (`skip.category`) |
| --- | --- | --- |
| `R − union ≠ ∅` (no driver advertises all required caps) | selection ([§7](#7-driver-selection-algorithm)) | `capability` |
| `session.create` returns `-32002 METHOD_NOT_SUPPORTED` (required ⊄ advertised) | handshake ([§6](#6-the-negotiation-handshake)) | `capability` |
| Pinned driver can't satisfy `R` | selection | `capability` |
| Target's `loader`/`mc` excluded by the test's `appliesTo:` guard | YAML ([§10](#10-declaring-required-capabilities--yaml-front-matter)) | `target` |
| Required co-driver (server agent) absent for this target | handshake | `environment` |
| A declared **optional** capability is missing | — | *(never a skip; recorded as `optionalGranted` delta)* |

### 8.2 What is **not** a skip

- An **unknown capability key** in `requires:` → test **error** (`configuration`), because the test is malformed. (Closed-key rule, [§2](#2-capability-model--vocabulary).)
- A primitive failing at runtime, an assertion failing, a timeout → test **failure**/**error**, never skip.
- Calling a primitive whose capability wasn't granted, *after* a successful negotiation (`-32002`) → test **error** (runner bug).

### 8.3 The skip reason string

Skips render a single canonical reason line (also stored structured in the report):

```
SKIPPED [<category>] NO_COMPATIBLE_DRIVER: target <loader>/<mc>/<driver?> cannot satisfy required capability {<unmet>}
  required: [<R>]
  best driver: <driver> advertised [<union>]
  hint: <actionable hint>
```

Concrete example (the regions **client-GUI** variant on a Paper target that has no client):

```
SKIPPED [capability] NO_COMPATIBLE_DRIVER: target paper/1.21.4 cannot satisfy required capability {clientScreens}
  required: [command, chat, clientScreens, rendering, screenshot]
  best driver: headless advertised [command, chat, containerGui]
  hint: clientScreens needs the in-process client agent (driver: inprocess). Add an
        inprocess-capable target row for this mod, or relax to anyOf:[containerGui, clientScreens].
```

The **structured** form attached to the result (and serialized into the report, [§9](#9-skips-in-junit-xml-reports)):

```jsonc
{
  "outcome": "skipped",
  "skip": {
    "category": "capability",
    "reason": "NO_COMPATIBLE_DRIVER",
    "unmet": ["clientScreens"],
    "required": ["command","chat","clientScreens","rendering","screenshot"],
    "bestDriver": "headless",
    "advertised": ["command","chat","containerGui"],
    "target": { "loader": "paper", "mc": "1.21.4" },
    "message": "target paper/1.21.4 cannot satisfy required capability {clientScreens}",
    "hint": "clientScreens needs the in-process client agent (driver: inprocess)..."
  }
}
```

### 8.4 Exit-code policy

By default, **skips do not fail the run** (exit `0` if no failures/errors). The runner CLI flag `--fail-on-skip` (or `mc-test.yml: reporting.failOnSkip: true`) flips this so a skipped test makes the run exit non-zero — useful to catch *unintended* coverage gaps in CI. Independently, `--max-skip-ratio <0..1>` fails the run if the fraction of skipped tests exceeds the threshold.

---

## 9. Skips in JUnit XML reports

The runner emits standard **JUnit XML** (consumed by CI dashboards, GitHub Actions, etc.) via `/packages/runner` (JUnit reporter). Skips use the JUnit `<skipped>` element so every CI UI renders them as "skipped" (not failed), while the **reason** and **structured detail** ride along.

### 9.1 Mapping

| `mc-test` outcome | JUnit element under `<testcase>` | Notes |
| --- | --- | --- |
| pass | *(none)* | `<testcase>` with no child failure/error/skipped |
| skipped | `<skipped message="...">` | `message` = the reason line from [§8.3](#83-the-skip-reason-string) |
| failure (assertion) | `<failure message="..." type="AssertionError">` | — |
| error (infra/config/post-negotiation `-32002`) | `<error message="..." type="...">` | unknown-cap, granted-violation, infra |

- One `<testcase>` is emitted **per (test × target)**. The target identity goes on attributes so a single test name appears once per matrix cell.
- `time` is the wall time spent (for a skip this is the negotiation time, typically a few ms).
- The structured skip JSON ([§8.3](#83-the-skip-reason-string)) is embedded verbatim inside the `<skipped>` text node (CDATA) so downstream tooling can recover `unmet`, `bestDriver`, etc.
- **Brittle-driver flag.** When the cell ran on a driver advertising the advisory `brittle` descriptor (the pixel/OCR driver — see [§4](#4-driver--capability-matrix)), the runner additionally emits `<property name="brittle" value="true"/>` on the `<testcase>` (mirroring the loud console note). `brittle` is **not** a capability key and never appears in `required`/`granted`; this property is purely a reporting signal that the result leaned on a last-resort, flaky driver.
- **Full-matrix skip matrix.** A full-matrix run (`mc-test run <file> --target all`, [§9.4](#94-full-matrix-runs-and-the-test--target-skip-matrix)) aggregates every cell into **one** JUnit document and, in addition, prints a `(test × target)` **skip matrix** to the console — which cells were skipped and why, rendered as the machine-readable capability reason strings from [§8.3](#83-the-skip-reason-string).

### 9.2 Example — regions client-GUI variant skipped on a Paper target

```xml
<testsuite name="regions" tests="1" skipped="1" failures="0" errors="0" time="0.012">
  <testcase
      classname="examples.regions.client"
      name="open /or, click Regions, click TestRegion, assert Region loaded [paper/1.21.4]"
      time="0.012">
    <properties>
      <property name="loader"      value="paper"/>
      <property name="mc"          value="1.21.4"/>
      <property name="driver"      value="(none)"/>
      <property name="required"    value="command,chat,clientScreens,rendering,screenshot"/>
      <property name="skipCategory" value="capability"/>
    </properties>
    <skipped message="SKIPPED [capability] NO_COMPATIBLE_DRIVER: target paper/1.21.4 cannot satisfy required capability {clientScreens}; best driver headless advertised [command,chat,containerGui]; hint: needs driver inprocess">
<![CDATA[
{"outcome":"skipped","skip":{"category":"capability","reason":"NO_COMPATIBLE_DRIVER","unmet":["clientScreens"],
"required":["command","chat","clientScreens","rendering","screenshot"],"bestDriver":"headless",
"advertised":["command","chat","containerGui"],"target":{"loader":"paper","mc":"1.21.4"},
"hint":"clientScreens needs the in-process client agent (driver: inprocess)"}}
]]>
    </skipped>
  </testcase>
</testsuite>
```

### 9.3 Example — same regions test, **headless** variant, passing on the same target

```xml
<testsuite name="regions" tests="1" skipped="0" failures="0" errors="0" time="3.481">
  <testcase
      classname="examples.regions.headless"
      name="open /or, click Regions, click TestRegion, assert Region loaded [paper/1.21.4]"
      time="3.481">
    <properties>
      <property name="loader"   value="paper"/>
      <property name="mc"       value="1.21.4"/>
      <property name="driver"   value="headless"/>
      <property name="coDriver" value="server"/>
      <property name="granted"  value="command,chat,containerGui,worldTruth,pluginState"/>
    </properties>
    <!-- no failure/error/skipped child => passed -->
  </testcase>
</testsuite>
```

> The two `<testcase>` rows above are the **same authored test** resolved against two different target rows (one demanding a client GUI, one accepting the inventory GUI). This is the payoff of capability negotiation: write once, let the matrix + negotiation decide *run* vs *skip-with-reason*.

### 9.4 Full-matrix runs and the (test × target) skip matrix

`mc-test run <file> --target all` (or `--target` omitted) runs the file against **every** target in `mc-test.yml`, aggregates all `(test × target)` cells into **one** JUnit document (one `<testsuite>` per target, as usual), and additionally prints a `(test × target)` **skip matrix** to the console. Each cell shows whether the test `ran`/`skipped`/`failed` on that target, and for a skip carries the machine-readable reason string from [§8.3](#83-the-skip-reason-string) (`NO_COMPATIBLE_DRIVER` with `unmet[…]`, `skip[target]`, etc.) so an at-a-glance grid explains exactly which cells were skipped and why — the honest-skip principle made legible across the whole matrix.

When a cell was served by a `brittle`-advertising driver (the pixel/OCR driver), its `<testcase>` carries the `<property name="brittle" value="true"/>` flag from [§9.1](#91-mapping):

```xml
<testcase classname="examples.regions.pixel"
    name="open /or, click Regions, click TestRegion [paper/1.8.9]" time="9.204">
  <properties>
    <property name="driver"  value="pixel"/>
    <property name="brittle" value="true"/>
    <property name="granted" value="command,chat,clientScreens,screenshot,rendering"/>
  </properties>
  <!-- no failure/error/skipped child => passed (but flagged brittle) -->
</testcase>
```

---

## 10. Declaring required capabilities — YAML front-matter

A YAML step file declares capabilities in its **front-matter** (the `meta` block at the top, ahead of `steps:`). The loader in `/packages/runner` parses this; the schema lives in `/packages/protocol`.

### 10.1 Front-matter schema (capability-relevant fields)

```yaml
meta:
  name: string                      # human test name (becomes JUnit testcase name stem)
  requires:                         # REQUIRED capabilities — missing ⇒ skip[capability]
    - <capabilityKey>               #   plain key, e.g. command
    - anyOf: [<key>, <key>, ...]    #   group: satisfied if ≥1 member is advertised
    - allOf: [<key>, <key>, ...]    #   group: all members required (sugar; same as listing each)
  optional:                         # OPTIONAL capabilities — granted if available, never skip
    - <capabilityKey>
  appliesTo:                        # OPTIONAL target guard — non-match ⇒ skip[target]
    loaders: [paper, spigot, folia, fabric, forge, neoforge, quilt]   # any-of; omit ⇒ all
    mc: ">=1.16 <1.22"             # semver-style range over MC versions; omit ⇒ all
  driver: <driverId>                # OPTIONAL hard pin (server|headless|inprocess|pixel)
```

Validation rules:
- Every leaf key must be one of the capability keys defined in `PROTOCOL.md` (mirrored in [§3](#3-canonical-capability-keys)). Unknown key ⇒ **error** (`configuration`), not skip.
- `requires` and `optional` must be **disjoint**.
- `anyOf`/`allOf` may not nest. `allOf:[a,b]` is exactly `requires:[a,b]`.
- `appliesTo` filters *before* negotiation; a non-matching target yields `skip[target]` without opening a session.

### 10.2 Regions test — **portable** variant (runs headless on plugins, in-process on mods)

This is the recommended canonical form: it requires `command` + `chat`, accepts **either** UI surface, and pulls `pluginState` from the server co-driver.

```yaml
# examples/regions/regions.portable.mc.yml
meta:
  name: "regions: /or → Regions → TestRegion → asserts"
  requires:
    - command                       # to run /or
    - chat                          # to read "Region loaded"
    - anyOf: [containerGui, clientScreens]   # chest-menu OR real client Screen
    - pluginState                   # region "TestRegion" exists (server-owned co-driver)
  optional:
    - screenshot                    # capture on failure if a rendered client is in play
  # no driver pin, no appliesTo ⇒ runs on every matrix target that can satisfy the above

steps:
  - join: localhost
  - command: "/or"
  - waitForScreen: { titleContains: "Overlord Regions" }
  - clickElement: { label: "Regions" }            # resolver depends on granted UI cap
  - clickElement: { label: "TestRegion" }
  - assertChatContains: "Region loaded"
  - assertPluginState:                            # uses pluginState cap → truth.assertPluginState primitive
      namespace: regions
      query: { type: regionExists, name: "TestRegion" }
      expect: true
```

On a **Paper plugin** target: `anyOf` resolves to `containerGui`; selection picks `headless` + `server` co-driver; `screenshot` is dropped (`optionalGranted: []`); test **runs**.

On a **Fabric mod** target with a rendered client: `anyOf` resolves to `clientScreens`; selection picks `inprocess` + `server` co-driver; `screenshot` granted; test **runs** and captures on failure.

On a **Paper plugin** target *with no server agent installed*: `pluginState` unsatisfiable ⇒ `skip[capability] {pluginState}`.

### 10.3 Regions test — **client-GUI-only** variant (forces a real rendered Screen)

Use when the *point* of the test is the real mod GUI (rendering, widget layout, screenshot diffing). This **intentionally skips** on any target without a rendered client agent.

```yaml
# examples/regions/regions.clientgui.mc.yml
meta:
  name: "regions client GUI: /or screen renders & is clickable"
  requires:
    - command
    - chat
    - clientScreens                  # MUST be a real client Screen (not a container menu)
    - rendering                     # framebuffer must be live
    - screenshot                    # we diff the rendered screen
    - pluginState
  appliesTo:
    loaders: [fabric, forge, neoforge, quilt]   # mods only; plugins can't render client GUIs
steps:
  - join: localhost
  - command: "/or"
  - waitForScreen: { titleContains: "Overlord Regions" }
  - screenshot: { name: "or-root" }
  - clickElement: { testId: "regions.button.regions" }   # invisible testId tag, robust select
  - clickElement: { label: "TestRegion" }
  - assertChatContains: "Region loaded"
  - assertPluginState: { namespace: regions, query: { type: regionExists, name: "TestRegion" }, expect: true }
```

On a Paper target: `appliesTo.loaders` excludes it ⇒ `skip[target]` (no session opened). On a Fabric target whose client is headless (no display): `rendering`/`screenshot` unsatisfiable ⇒ `skip[capability] {rendering,screenshot}`.

---

## 11. Declaring required capabilities — fluent API

The TypeScript fluent API (`/packages/runner`, exported types from `/packages/protocol`) mirrors the YAML one-to-one. Capability keys are a **string-literal union** `CapabilityKey`, so typos are compile errors (the closed-key rule, enforced by the type system).

### 11.1 Surface

```ts
import { test, cap } from "@mc-test/runner";

// cap.* are the capability keys as typed constants (spellings per PROTOCOL.md):
//   cap.command  cap.chat  cap.containerGui  cap.clientScreens  cap.rendering
//   cap.screenshot  cap.worldTruth  cap.pluginState  cap.fixtures  cap.fakePlayers

test("regions: /or → Regions → TestRegion → asserts")
  .requires(cap.command, cap.chat)                       // hard requirements (AND)
  .requiresAnyOf(cap.containerGui, cap.clientScreens)     // a group: ≥1 must be advertised
  .requires(cap.pluginState)                             // server-owned, via co-driver
  .optional(cap.screenshot)                              // never causes a skip
  // .appliesTo({ loaders: ["fabric","forge","neoforge","quilt"], mc: ">=1.16 <1.22" })
  // .driver("inprocess")                                // optional hard pin
  .steps(async (s, ctx) => {
    await s.join("localhost");
    await s.command("/or");                              // needs cap.command
    await s.waitForScreen({ titleContains: "Overlord Regions" });
    await s.clickElement({ label: "Regions" });         // needs containerGui|clientScreens
    await s.clickElement({ label: "TestRegion" });
    await s.assertChatContains("Region loaded");        // needs cap.chat

    if (ctx.has(cap.screenshot)) {                       // branch on optional grant
      await s.screenshot({ name: "regions-open" });
    }

    await s.assertPluginState({                          // needs cap.pluginState
      namespace: "regions",
      query: { type: "regionExists", name: "TestRegion" },
      expect: true,
    });
  });
```

### 11.2 Method ↔ declaration semantics

| Fluent call | Effect on the required/optional sets |
| --- | --- |
| `.requires(...keys)` | Adds each key to `R` (logical AND). Repeatable; unions. |
| `.requiresAnyOf(...keys)` | Adds an `anyOf` **group** to `R` (logical OR within the group). |
| `.requiresAllOf(...keys)` | Sugar for `.requires(...keys)`. |
| `.optional(...keys)` | Adds to `O`. Granted-if-available; never skips. Disjoint from `R` (overlap = compile/throw). |
| `.appliesTo({loaders?, mc?})` | Target guard; non-match ⇒ `skip[target]` before negotiation. |
| `.driver(id)` | Hard pin; selection validates instead of choosing ([§7](#7-driver-selection-algorithm)). |

Runtime introspection available inside `.steps(...)` via `ctx`:

| `ctx` member | Returns |
| --- | --- |
| `ctx.granted` | `readonly CapabilityKey[]` actually granted for this session. |
| `ctx.has(key)` | `boolean` — is `key` in `granted`? (Use to branch on `optional`.) |
| `ctx.driver` | `"server"｜"headless"｜"inprocess"｜"pixel"` chosen. |
| `ctx.coDriver` | the co-driver id or `null`. |
| `ctx.skip(reason)` | Programmatic, **reasoned** skip from inside a step (renders as `skip[manual]`). |

A `.requires(...)` key that no target can satisfy produces exactly the same `skip[capability]` outcome and JUnit `<skipped>` element as the YAML path — the two front-ends compile to the **same** required/optional sets fed to selection ([§7](#7-driver-selection-algorithm)).

---

## 12. End-to-end: the regions test, negotiated

Putting it together for two matrix rows in `mc-test.yml`:

```yaml
# mc-test.yml (excerpt)
targets:
  - id: regions-paper
    loader: paper
    mc: "1.21.4"
    world: snapshots/regions-pristine
    plugins: [overlord-regions, mc-test-server-bukkit]    # SUT + server agent
    # no driver pin → runner chooses
  - id: regions-fabric-client
    loader: fabric
    mc: "1.21.4"
    world: snapshots/regions-pristine
    mods: [overlord-regions, mc-test-server-fabric, mc-test-client-fabric]  # SUT + server agent + client agent
    driver: inprocess
    display: xvfb
```

Running `regions.portable.mc.yml` ([§10.2](#102-regions-test--portable-variant-runs-headless-on-plugins-in-process-on-mods)) across these rows:

| Step | `regions-paper` | `regions-fabric-client` |
| --- | --- | --- |
| `appliesTo` guard | (none) → proceed | (none) → proceed |
| `describe` | `headless`→[command,chat,containerGui]; `server` co→[…,pluginState,worldTruth,fixtures] | `inprocess`→[command,chat,clientScreens,rendering,screenshot]; `server` co→[…,pluginState] |
| `anyOf[containerGui,clientScreens]` | resolves **containerGui** | resolves **clientScreens** |
| selection ([§7](#7-driver-selection-algorithm)) | primary `headless` + co `server` | primary `inprocess` + co `server` |
| `session.create` granted | command,chat,containerGui,pluginState | command,chat,clientScreens,pluginState,**screenshot** |
| `optional screenshot` | dropped (`optionalGranted:[]`) | granted |
| `/or` → click **Regions** → **TestRegion** | container slots resolved by display-name | widgets resolved by `getMessage()` |
| `assertChatContains "Region loaded"` | via `world.waitForChat` | via `world.waitForChat` |
| `assertPluginState regionExists TestRegion` | via `server` co-driver `truth.assertPluginState` | via `server` co-driver `truth.assertPluginState` |
| **Outcome** | **pass** | **pass** (+ screenshot artifact) |

Now run the **client-GUI-only** variant ([§10.3](#103-regions-test--client-gui-only-variant-forces-a-real-rendered-screen)) across the same rows:

| | `regions-paper` | `regions-fabric-client` |
| --- | --- | --- |
| `appliesTo.loaders=[fabric,…]` | **excludes paper** → `skip[target]` (no session) | match → proceed |
| Outcome | **skipped** (`<skipped message="SKIPPED [target]: paper not in [fabric,forge,neoforge,quilt]">`) | **pass** with `or-root` screenshot |

This is the whole thesis in one table: **one authored test, negotiated per target, yielding deterministic pass / skip-with-reason — fast where it can be, rendered only where it must be.**

---

## 13. Cross-doc contract

A consolidated reference of every identifier this document **uses or owns**. Wire spellings (capability keys, primitive method names, error codes) are **defined in `PROTOCOL.md`** and reproduced here verbatim; the skip outcome shape, driver ids/cost order, YAML front-matter keys, and fluent API surface are owned by this document.

### 13.1 Capability keys (semantics registry — spellings defined in `PROTOCOL.md`)
`command` · `chat` · `containerGui` · `clientScreens` · `rendering` · `screenshot` · `worldTruth` · `pluginState` · `fixtures` · `fakePlayers`

### 13.2 Driver ids (4)
`server` · `headless` · `inprocess` · `pixel`
(Cost order, cheapest→costliest: `server` < `headless` < `inprocess` < `pixel`.)

### 13.3 MCTP primitive methods & their gating capability
| Method | Gating capability |
| --- | --- |
| `world.runCommand` | `command` |
| `world.sendChat` | `chat` |
| `world.waitForChat` | `chat` |
| `screen.listElements` | `containerGui`｜`clientScreens` |
| `screen.clickElement` | `containerGui`｜`clientScreens` |
| `screen.get` | `containerGui`｜`clientScreens` |
| `screen.typeText` | `clientScreens` |
| `screen.pressKey` | `clientScreens` |
| `screen.screenshot` | `screenshot` |
| `truth.getWorldBlock` | `worldTruth` |
| `truth.getEntities` | `worldTruth` |
| `truth.assertPluginState` | `pluginState` |
| `fixture.set` | `fixtures` |
| `fixture.reset` | `fixtures` |
| `player.spawnFake` | `fakePlayers` |
| `player.despawnFake` | `fakePlayers` |

### 13.4 MCTP session methods
`session.describe` (probe → advertised caps) · `session.create` (params `{ required, optional, actor }` → result `{ sessionId, capabilities:{ granted, optionalGranted, detail } }`)

### 13.5 Negotiation error codes
Error codes are defined in `PROTOCOL.md` (single source of truth); this doc only states how the runner reacts to them.
`-32002 METHOD_NOT_SUPPORTED` at `session.create` (required ⊄ advertised; data `{ unmet, advertised }`) → runner emits **skip** with runner-level reason `NO_COMPATIBLE_DRIVER` (carries `unmet[]`) ·
`-32002 METHOD_NOT_SUPPORTED` on a primitive called *after* a successful negotiation (its capability was not granted) → runner emits **error**.

### 13.6 Skip outcome shape
`{ outcome:"skipped", skip:{ category, reason, unmet, required, bestDriver, advertised, target, message, hint } }`
`skip.category` ∈ `{ capability, target, environment, configuration, manual }`. `skip.reason` is the runner-level token, e.g. `NO_COMPATIBLE_DRIVER` for the `capability` category.

### 13.7 YAML front-matter keys (under `meta:`)
`name` · `requires` (leaf key | `anyOf:[…]` | `allOf:[…]`) · `optional` · `appliesTo:{ loaders, mc }` · `driver`

### 13.8 Fluent API surface
`test(name)` · `.requires(...keys)` · `.requiresAnyOf(...keys)` · `.requiresAllOf(...keys)` · `.optional(...keys)` · `.appliesTo({loaders?,mc?})` · `.driver(id)` · `.steps(async (s, ctx) => …)`
Context: `ctx.granted` · `ctx.has(key)` · `ctx.driver` · `ctx.coDriver` · `ctx.skip(reason)`
Typed key constants: `cap.command … cap.fakePlayers`; type `CapabilityKey` (string-literal union of the capability keys defined in `PROTOCOL.md`).

### 13.9 Runner CLI / report config (capability-related)
`--fail-on-skip` (`reporting.failOnSkip`) · `--max-skip-ratio <0..1>` · `--target all` (full-matrix run → one aggregated JUnit + a printed `(test × target)` skip matrix, [§9.4](#94-full-matrix-runs-and-the-test--target-skip-matrix)) · JUnit `<skipped message="…">` with structured-JSON CDATA body · `<property>` keys: `loader`, `mc`, `driver`, `coDriver`, `required`, `granted`, `skipCategory`, and `brittle` (`"true"` when the cell ran on a `brittle`-advertising driver — advisory descriptor owned by `PROTOCOL.md`, never a capability key).

### 13.10 Canonical paths referenced
`docs/CAPABILITIES.md` (this) · `docs/PROTOCOL.md` · `docs/DRIVERS.md` · `packages/protocol` (JSON Schema + TS types) · `packages/runner` (loader, selection, JUnit reporter) · `examples/regions/regions.portable.mc.yml` · `examples/regions/regions.clientgui.mc.yml` · `mc-test.yml`.
