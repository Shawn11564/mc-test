# MC Test Protocol (MCTP) Specification

**Status:** Stable contract — the keystone of `mc-test`.
**Protocol version:** `1.0` (negotiated `protocolVersion`, starting at `"1.0"`).
**Audience:** implementers of the TypeScript runner/client (`/packages/runner`, `/packages/protocol`), the TypeScript drivers (`/packages/driver-headless`, `/packages/driver-inprocess`), and the Java/Kotlin in-game agents (`/agents/core`, `/agents/client-*`, `/agents/server-*`).

> **This document is the SINGLE SOURCE OF TRUTH for the MCTP wire contract.** It is authoritative for the wire vocabulary: envelopes, the method catalog, params/results, the error model, events, capability **keys**, selector **keys**, the `testId` carriers, and the `protocolVersion` handshake. Every spelling here is canonical. All other documents — [`ROADMAP.md`](./ROADMAP.md), [`CAPABILITIES.md`](./CAPABILITIES.md), [`SELECTORS.md`](./SELECTORS.md), [`DRIVERS.md`](./DRIVERS.md), [`ARCHITECTURE.md`](./ARCHITECTURE.md), [`ENVIRONMENTS.md`](./ENVIRONMENTS.md) — **use** these names and **defer to this document for their definition**. Where any other doc disagrees with a wire spelling, PROTOCOL.md wins.

---

## 0. Purpose and position in the architecture

MCTP is the **narrow waist** of the `mc-test` framework. A test is authored **once** in semantic steps (the top layer) and executed across a matrix of Minecraft versions and loaders by **swappable drivers** (the bottom layer). MCTP is the single stable wire contract that decouples the two:

```
   Test authoring (fluent API / YAML / record-replay)   <- write once
              |
              v
   ============ MCTP (JSON-RPC 2.0 / WebSocket) ============   <- THE KEYSTONE (this doc)
              |
   +----------+-----------+-----------+----------------+
   v          v           v           v                v
 headless   in-process  server-     server-          pixel/OCR
 bot        client mod  bukkit      fabric           driver
 (TS)       (Java mod)  (plugin)    (server mod)     (universal)
```

Two hard rules shape every decision below:

1. **Agents are tiny and dumb.** An in-game agent (the WebSocket *server* side of MCTP) exposes **primitives only**: list/click elements, read a screen, type, press keys, screenshot, read world blocks/entities, set fixtures, spawn fake players, assert plugin state. **All intelligence** — selector resolution strategy choice, retries, waits, assertions, orchestration, reporting — lives **outside** the game in the runner. The protocol therefore exposes mechanism, not policy.
2. **Selectors are semantic, never coordinates.** Every element-addressing command carries a **semantic selector object** (`label`, `text`, `textContains`, `loreContains`, `itemType`, `role`, `nth`, `within`, `testId`, …). The selector **grammar** is owned by [`SELECTORS.md`](./SELECTORS.md); this document references its keys and pins the wire shape, but does not redefine the matching semantics.

> **Naming convention.** All MCTP method names are **namespaced `noun.verb`** (e.g. `screen.clickElement`, `world.runCommand`); the namespace groups are `session.*`, `world.*`, `screen.*`, `truth.*`, `fixture.*`, `player.*`, and event notifications `event.*`. All JSON field names are `lowerCamelCase`. Enum string values are `lowerCamelCase` unless they mirror a Minecraft identifier (which uses `namespace:path`). Capability keys are **flat `lowerCamelCase`** tokens (e.g. `clientScreens`, `containerGui`) — never dotted. These conventions are normative so TS and Java code generators agree.

---

## 1. Conformance and terminology

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT**, **MAY**, and **OPTIONAL** are to be interpreted as described in RFC 2119.

- **Client** — the MCTP **caller**. In `mc-test` this is always the runner/orchestrator (`/packages/runner`) or a driver acting on its behalf (`/packages/driver-*`). The client opens the WebSocket connection and issues JSON-RPC **requests**.
- **Server** / **Agent** — the MCTP **callee**: an in-game agent that hosts the WebSocket endpoint and dispatches primitive commands. Three agent families exist: headless-bot agent, in-process client mod agent, and server-side agent (Bukkit plugin or server mod).
- **Driver** — the runner-side adapter that owns the policy for talking to one agent family over MCTP. Drivers are selected per target by **capability negotiation** (§5).
- **SUT** — System Under Test: the plugin or mod being tested (e.g. the `regions` plugin).
- **Session** — a negotiated, capability-scoped logical context bound to one connection (§4–§5).

A **conforming agent** MUST implement the transport (§2), the envelope (§3), the session lifecycle and handshake (§4–§5), the error model (§9), and every command it advertises as a granted capability. A **conforming client** MUST implement the transport, the envelope, correlation, the handshake, and the error model.

---

## 2. Transport

### 2.1 WebSocket

- MCTP runs over a single **WebSocket** connection (RFC 6455). The agent is the WebSocket **server**; the client is the WebSocket **initiator**.
- Default scheme `ws://`; `wss://` (TLS) MUST be supported when the agent is configured with a certificate. CI default is `ws://127.0.0.1:<port>` because agents bind loopback only by default.
- The WebSocket **sub-protocol** token is `mctp.v1`. The client SHOULD send it in `Sec-WebSocket-Protocol`; an agent that supports `1.x` MUST echo `mctp.v1`. If the agent does not support the offered sub-protocol it MUST fail the WebSocket handshake (HTTP 426 or close), and MUST NOT accept the connection silently.
- The default endpoint path is `/mctp`. Agents MAY expose additional paths but MUST serve `/mctp`.
- Each agent serves **exactly one** logical game target. Provisioning assigns a distinct port per target so suites run in parallel across ports (see `mc-test.yml`).

### 2.2 Framing and encoding

- Every WebSocket **text** message is exactly **one** JSON value: a single MCTP envelope object (§3). Batching (JSON-RPC arrays) is **NOT** supported in `1.x` — one envelope per frame keeps Java and TS parsers trivial.
- Encoding is UTF-8. Numbers follow JSON/IEEE-754. 64-bit identifiers that may exceed `2^53` (entity ids, world seeds) MUST be transmitted as **strings**, never bare numbers.
- Binary payloads (screenshots) are **not** sent as WebSocket binary frames in `1.x`. They are returned as base64 strings inside a normal JSON result, or by reference (URL/path) — see §8.1. This keeps the framing uniform and JSON-RPC-pure.
- Maximum single frame size is negotiated via the `maxFrameBytes` connection parameter (§4.2); default 8 MiB. A client that needs large screenshots SHOULD prefer the `ref` return mode (§8.1) over inflating the frame limit.

### 2.3 Keepalive and liveness

- Either peer MAY send WebSocket PING; the receiver MUST reply PONG. Recommended client PING interval: 15 s.
- Independently, MCTP defines an application-level `session.ping` method (§7.1) that also serves as a no-op latency probe and verifies the dispatch loop (not just the socket) is alive.
- If a client observes no PONG and no traffic for `2 × pingInterval`, it SHOULD treat the connection as dead, close it, and surface a `transportClosed` condition to the test as an error.

### 2.4 Connection vs. session

The **WebSocket connection** is the byte pipe. The **MCTP session** is the negotiated capability context (§4). In `1.x` a connection hosts **at most one** session at a time (the agent embodies a single game target). `session.create` MUST be the **first** request on a fresh connection; all subsequent stateful requests carry that session's `sessionId` (§3.2). Closing the session (`session.close`) does not necessarily close the socket; closing the socket implicitly ends any open session.

---

## 3. Message envelope

MCTP uses **JSON-RPC 2.0** verbatim for request/response, and JSON-RPC **notifications** for asynchronous events. Every envelope MUST include `"jsonrpc": "2.0"`.

There are exactly four envelope shapes:

| Shape | Direction | Has `id` | Has `method` | Has `result`/`error` |
|---|---|---|---|---|
| **Request** | client → agent | yes | yes | no |
| **Response (success)** | agent → client | yes (echoes request) | no | `result` |
| **Response (error)** | agent → client | yes (echoes request) | no | `error` |
| **Event (notification)** | agent → client | **no** | yes (`event.*`) | no |

### 3.1 Request

```json
{
  "jsonrpc": "2.0",
  "id": 42,
  "method": "screen.clickElement",
  "params": {
    "sessionId": "s_7f3c1a",
    "selector": { "label": "Regions" }
  }
}
```

- `id` — correlation id. MUST be a JSON **number** (monotonic per connection is RECOMMENDED) or **string**, unique among in-flight requests on that connection. MUST NOT be `null`. The agent MUST echo it byte-for-identical-value in the matching response.
- `method` — an MCTP method name from §7.
- `params` — a **by-name** object (JSON-RPC positional arrays are NOT used in MCTP). MAY be omitted only for methods whose entire parameter set is optional (e.g. `session.ping`). Every stateful method requires `params.sessionId` (§3.2).

### 3.2 The `sessionId` parameter

- All methods **except** `session.create`, `session.ping`, and `session.describe` MUST include `params.sessionId`.
- `session.create` returns the `sessionId` the agent assigns; the client MUST use that exact value thereafter.
- A request with a missing/unknown/closed `sessionId` MUST fail with `-32602 invalidParams` (§9.2).

### 3.3 Response — success

```json
{
  "jsonrpc": "2.0",
  "id": 42,
  "result": {
    "ok": true,
    "screenChanged": true
  }
}
```

- `result` is always a **JSON object** (never a bare scalar/array) so fields can be added compatibly. Commands with no natural payload return `{ "ok": true }`.
- Every successful `result` MAY include the common envelope fields in §3.5.

### 3.4 Response — error

```json
{
  "jsonrpc": "2.0",
  "id": 42,
  "error": {
    "code": -32000,
    "message": "No element matched selector",
    "data": {
      "reason": "ELEMENT_NOT_FOUND",
      "selector": { "label": "Regions" },
      "screenId": "regions:root",
      "candidatesConsidered": 7,
      "retryable": true
    }
  }
}
```

The error object follows JSON-RPC 2.0 (`code`, `message`, `data`). MCTP pins the structure of `data` in §9.

### 3.5 Common result fields (envelope metadata)

Any success `result` MAY carry these reserved fields; clients MUST ignore unknown fields:

| Field | Type | Meaning |
|---|---|---|
| `ok` | boolean | Convenience success flag. Always `true` on a success response. |
| `screenChanged` | boolean | The agent detected the active screen/window changed as a side effect of this command. Lets the runner decide whether to re-query without a separate event round-trip. |
| `tookMs` | number | Agent-side wall-clock the command consumed (excludes network). |
| `serverTick` | number | The game tick (Long-as-number if < 2^53, else string) at which the command was applied. Useful for ordering against events. |
| `warnings` | string[] | Non-fatal advisories (e.g. "selector matched via OCR fallback"). |

### 3.6 Events (notifications)

Events are JSON-RPC **notifications**: they have `method` but **no `id`** and therefore receive no response.

```json
{
  "jsonrpc": "2.0",
  "method": "event.chat",
  "params": {
    "sessionId": "s_7f3c1a",
    "subscriptionId": "sub_chat_1",
    "seq": 128,
    "tsMs": 1718412345678,
    "data": {
      "text": "Region loaded",
      "rawJson": "{\"text\":\"Region loaded\",\"color\":\"green\"}",
      "sender": "server",
      "channel": "system"
    }
  }
}
```

- All event methods are namespaced `event.*` so they can never collide with request methods.
- `params.sessionId` binds the event to its session.
- `params.subscriptionId` ties the event to the `subscribe` call that created the stream (§7.6); it is present only for subscription-stream events (lifecycle events like `event.disconnected` omit it).
- `params.seq` is a per-subscription monotonically increasing integer (gap detection / replay).
- `params.tsMs` is the agent's Unix epoch millis when the event was emitted.
- `params.data` is the event-type-specific payload (§7.6).

Clients MUST tolerate receiving an event whose `subscriptionId` they have already unsubscribed (in-flight races); such events SHOULD be dropped.

### 3.7 Ordering guarantees

- Responses MAY arrive out of request order; clients MUST correlate strictly by `id`. (Most agents are single-threaded against the game thread and answer in order, but clients MUST NOT rely on it.)
- Events for a given `subscriptionId` are delivered **in `seq` order** over a single connection.
- The relative order of an event versus a command response is **not** guaranteed except via `serverTick`/`seq`. Tests that need "command X happened-before event Y" MUST compare `serverTick`.

---

## 4. Session lifecycle

### 4.1 State machine

```
            session.create (ok)            world.join (ok)
 [Disconnected] ─────────────► [Ready] ───────────────────► [Connected]
       ▲                          │                              │
       │ session.close / socket    │ session.close                 │ world.leave
       │ close / fatal error      ▼                              ▼
       └───────────────────── [Closed]  ◄────────────────── [Ready]
```

- **Disconnected** — socket open, no session. Only `session.create`, `session.ping`, `session.describe` are legal.
- **Ready** — session negotiated; capabilities granted; the agent is attached to its runtime but **not yet joined to a game/world** (for bot/client agents) or attached but idle (server agent). Query/input methods that require an active world MUST fail with `-32004 WORLD_NOT_READY` until `world.join` succeeds (where applicable).
- **Connected** — for bot/client drivers, the agent has joined the target server/world and input/query/capture are fully live. For the server-side agent, `world.join` is a no-op that simply transitions to Connected (the plugin/mod is already in-process), so fixtures are usable.
- **Closed** — terminal for that session; the `sessionId` is invalid forever.

> **Why `world.join` is separate from `session.create`.** A headless bot can negotiate capabilities and report them *before* paying the cost of logging into a world; the runner may decide to skip based on capabilities and never connect. The in-process client mod likewise negotiates before joining a server. Separating the two keeps capability negotiation cheap (Appium-style).

### 4.2 `session.create` — handshake request

`session.create` carries the **capability negotiation** (§5) and connection-tuning parameters. It is always the first request.

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "session.create",
  "params": {
    "protocolVersion": "1.0",
    "client": { "name": "mc-test-runner", "version": "0.4.2", "lang": "ts" },
    "requiredCapabilities": ["command", "containerGui", "worldTruth"],
    "optionalCapabilities": ["screenshot"],
    "constraints": { "mcVersionRange": "1.20.4", "loader": "paper" },
    "connection": {
      "maxFrameBytes": 8388608,
      "eventBufferSize": 1024,
      "defaultTimeoutMs": 15000,
      "locale": "en_us"
    }
  }
}
```

Field reference:

| Field | Req? | Meaning |
|---|---|---|
| `protocolVersion` | yes | The exact protocol version the client speaks, a `"<major>.<minor>"` string starting at `"1.0"` (§10). |
| `client.name` / `.version` / `.lang` | yes | Caller identity for logs/artifacts. `lang` ∈ `{ "ts", "java", "kotlin", "other" }`. |
| `requiredCapabilities` | yes | Capability keys (§6) the test cannot run without. Empty array means "any agent". |
| `optionalCapabilities` | no | Capabilities the client will use **if granted** but can proceed without. |
| `constraints` | no | Hints/assertions about the target, expressed with the target descriptors. The agent MAY refuse if it cannot satisfy them (e.g. wrong loader). Keys: `mcVersionRange` (string, e.g. `"1.20.4"` or a range), `loader` (enum), `worldId`. |
| `connection.maxFrameBytes` | no | Client's max acceptable inbound frame; agent MUST NOT send larger frames (use `ref` returns instead). |
| `connection.eventBufferSize` | no | Max events the agent buffers per subscription before applying overflow policy (§7.6). |
| `connection.defaultTimeoutMs` | no | Advisory default the agent applies to commands lacking an explicit `timeoutMs`. |
| `connection.locale` | no | Preferred locale for resolving translatable component text (affects `label`/`text` selectors that match translated strings). |

### 4.3 `session.create` — handshake response

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "ok": true,
    "sessionId": "s_7f3c1a",
    "protocolVersion": "1.0",
    "agent": {
      "name": "mc-test-driver-headless",
      "version": "0.4.2",
      "kind": "headlessBot",
      "lang": "ts"
    },
    "target": {
      "minecraft": "1.20.4",
      "protocolVersion": 765,
      "loader": "paper",
      "loaderVersion": "1.20.4-R0.1",
      "viaVersion": true
    },
    "grantedCapabilities": ["command", "containerGui", "worldTruth"],
    "deniedCapabilities": [],
    "capabilityDetails": {
      "containerGui": { "version": 1, "screenModel": "containerSlots" },
      "worldTruth": { "version": 1, "radiusLimit": 64 }
    },
    "limits": { "maxFrameBytes": 8388608, "maxConcurrentRequests": 16 }
  }
}
```

- `sessionId` — opaque token; the client MUST send it as `params.sessionId` on all later stateful calls.
- `agent.kind` ∈ `{ "headlessBot", "clientMod", "serverPlugin", "serverMod", "pixelOcr" }`.
- `grantedCapabilities` ⊇ are the negotiated subset (§5).
- `capabilityDetails` carries per-capability sub-features/limits (the capability's *value* — see §6.3).

If negotiation **fails**, the agent MUST return a JSON-RPC **error** instead of a result — see §5.3.

### 4.4 `session.close`

```json
{ "jsonrpc": "2.0", "id": 99, "method": "session.close", "params": { "sessionId": "s_7f3c1a", "reason": "suiteComplete" } }
```

Response `{ "ok": true }`. The agent MUST: cancel all subscriptions for the session, release fixtures/fake players it created, and invalidate the `sessionId`. The agent SHOULD keep the socket open so the client may close it cleanly; the agent MAY close the socket after responding.

### 4.5 `world.join` / `world.leave`

`world.join` joins the bot/client to the target world; for server-side agents it is a fast no-op that returns immediately (already in-process). See §7.1 for full payloads.

---

## 5. Capability negotiation (the handshake contract)

MCTP follows Appium/WebDriver: the **client declares what it needs**, the **agent advertises what it can do**, and the runner picks a compatible driver — or **skips with a clear reason** when none fits.

### 5.1 Negotiation algorithm (normative)

On receiving `session.create`, the agent MUST:

1. Verify the requested `protocolVersion` major is supported (§10). If not → error `-32099 PROTOCOL_VERSION_UNSUPPORTED`.
2. Evaluate each `constraints` entry (including the `loader` / `mcVersionRange` target descriptors). If a constraint cannot be satisfied → refuse, adding the unsatisfiable constraint to `data.unmet[]` (with `data.constraint`). **No session is created.**
3. Compute `grantedRequired = requiredCapabilities ∩ agentCapabilities`.
   - If `grantedRequired ≠ requiredCapabilities` (i.e., any required capability is missing) → the agent MUST refuse with a JSON-RPC error (`-32002 METHOD_NOT_SUPPORTED`), listing the missing keys in `data.unmet[]` and what it *does* offer in `data.offered`. **No session is created.** The runner maps this refusal to the skip outcome `NO_COMPATIBLE_DRIVER` (§5.3).
4. Compute `grantedOptional = optionalCapabilities ∩ agentCapabilities`.
5. Create the session and return `grantedCapabilities = grantedRequired ∪ grantedOptional`, `deniedCapabilities = optionalCapabilities \ agentCapabilities`, and `capabilityDetails` for each granted key.

The agent MUST NOT silently grant a capability it cannot fully honor. If it can only partially honor one, it MUST express the limitation in `capabilityDetails` (e.g. `worldTruth` with `radiusLimit`), not by denying.

### 5.2 Runner-side driver selection (informative)

The runner, not the protocol, chooses **which** agent to negotiate with. Typical flow per matrix target:

1. From the test's `requiredCapabilities`, filter the configured drivers to those whose static capability manifest is a superset.
2. Prefer the **cheapest** compatible driver (headless bot < server agent < in-process client < pixel/OCR).
3. `session.create` against the chosen driver. If it refuses (`-32002 METHOD_NOT_SUPPORTED` with `data.unmet[]`), try the next candidate.
4. If no candidate succeeds, mark the test **skipped** with the runner-level reason `NO_COMPATIBLE_DRIVER` (carrying the aggregate `unmet[]`) — this is a first-class outcome reported to JUnit XML, not a failure.

### 5.3 Refusal example

Test needs real client GUI (`clientScreens`) but only a headless bot is reachable:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32002,
    "message": "Required capabilities not available",
    "data": {
      "reason": "METHOD_NOT_SUPPORTED",
      "unmet": ["clientScreens", "screenshot"],
      "offered": ["command", "containerGui", "worldTruth"],
      "agentKind": "headlessBot",
      "retryable": false
    }
  }
}
```

The runner maps this to a **skip** with the runner-level reason `NO_COMPATIBLE_DRIVER`, carrying the `unmet[]` list built from `data.unmet`.

---

## 6. Capability catalog

Capability keys are **flat `lowerCamelCase`** tokens (never dotted). PROTOCOL.md is authoritative for the capability **keys** themselves (the canonical flat set below); the **authoritative registry**, value schemas, driver cost order, negotiation/skip outcome shapes, and the mapping of capability → semantics live in [`CAPABILITIES.md`](./CAPABILITIES.md), which **uses these keys and defers to this document for their spelling**. This section pins the keys MCTP itself references so the protocol is self-contained.

### 6.1 Core capability keys

The canonical capability-key set is exactly these flat keys:

| Capability key | Grants these methods | Typical agents |
|---|---|---|
| `chat` | `world.sendChat`, `world.waitForChat`, `event.chat` | headlessBot, clientMod, serverMod |
| `command` | `world.runCommand` | all that can act as a player |
| `containerGui` | `screen.get`, `screen.listElements`, `screen.clickElement` over **container/inventory** GUIs | headlessBot, clientMod, serverMod |
| `clientScreens` | `screen.get`, `screen.listElements`, `screen.clickElement`, `screen.waitForScreen`, `screen.close` over **client-rendered Screens/widgets** | **clientMod only** |
| `screenshot` | `screen.screenshot` | clientMod, pixelOcr |
| `rendering` | a live render surface exists (precondition for `screenshot`; pixel/OCR resolution) | clientMod, pixelOcr |
| `worldTruth` | `truth.getWorldBlock`, `truth.getEntities` | serverPlugin, serverMod, headlessBot (via server agent) |
| `pluginState` | `truth.assertPluginState` | serverPlugin, serverMod |
| `fixtures` | `fixture.reset`, `fixture.set` | serverPlugin, serverMod |
| `fakePlayers` | `player.spawnFake`, `player.despawnFake` | serverPlugin (Carpet), serverMod |
| `typeText` | `screen.typeText` | headlessBot (anvil/sign), clientMod, pixelOcr |
| `pressKey` | `screen.pressKey` | clientMod, pixelOcr |
| `testIdTags` | `testId` selector resolution via the `testId` carriers (§7.3.2) | headlessBot, clientMod, serverMod (SUTs we control) |

Two **target descriptors** accompany the capability set in negotiation (they describe the target, not a surface): `loader` (enum) and `mcVersionRange` (string).

> **Non-normative extension capabilities.** Some agents expose extra surfaces that are **not** part of the canonical set above and **not** part of the canonical method catalog (§13): world join/leave gating, click, item-use, movement, player-state reads, log reads, and screen-change streams (driving the extension methods `useItem`, `move`, `getWindow`, `getPlayerState`, `getLogs`, `subscribe`/`unsubscribe`). These are agent extensions; CAPABILITIES.md may register them, but they do not bump the canonical wire vocabulary. Clicking and waiting on screens are gated by `containerGui`/`clientScreens`; joining/leaving a world is available to any world-capable agent.

### 6.2 Capability bundles (informative)

Drivers typically advertise these bundles; the runner may request them by listing the member keys:

- **headlessBot** → `command, chat, containerGui, typeText, testIdTags` (+ `worldTruth` when paired with a server agent over the same matrix target).
- **clientMod** → everything in headlessBot **plus** `clientScreens, pressKey, screenshot, rendering`.
- **serverPlugin / serverMod** → `worldTruth, pluginState, fixtures, fakePlayers, chat, testIdTags` (no client UI).
- **pixelOcr** → `pressKey, typeText, screenshot, rendering` (selectors resolved by OCR/template; brittle, last resort).

### 6.3 Capability detail (value) objects

When granting a capability, the agent MAY attach a value object under `capabilityDetails[key]`. Reserved sub-fields used by this spec:

| Capability | Detail field | Meaning |
|---|---|---|
| `containerGui` | `screenModel` | `"containerSlots"` — element model is slot-indexed item stacks. |
| `clientScreens` | `widgetTree` | `true` if the agent can return a hierarchical widget tree (vs. flat list). |
| `worldTruth` | `radiusLimit` | max block radius per `truth.getEntities`/scan. |
| `screenshot` | `formats` | array, e.g. `["png"]`; `maxWidth`/`maxHeight`. |
| `fakePlayers` | `backend` | `"carpet"` \| `"native"`. |
| any | `version` | integer sub-feature version for that capability surface. |

---

## 7. Primitive command catalog

All commands are primitives: they perform **one** observable action or return **one** snapshot. No command embeds waiting, retrying, or assertion logic beyond a single bounded `timeoutMs`. Higher-order behavior (poll-until, retry-on-stale, semantic asserts) is composed by the runner.

Common optional parameters accepted by **every** command (besides `session.create`):

| Param | Type | Default | Meaning |
|---|---|---|---|
| `sessionId` | string | — (required) | Target session (§3.2). |
| `timeoutMs` | number | `connection.defaultTimeoutMs` | Hard upper bound for the agent to complete this single primitive; on expiry the agent MUST return `-32003 TIMEOUT`. This is **not** a retry budget. |
| `requestId` | string | — | Optional client-supplied idempotency/trace tag echoed in `result.echo.requestId` and in logs/artifacts. Distinct from JSON-RPC `id`. |

The catalog is grouped: **session**, **input**, **query**, **capture**, **fixtures**, **events**.

---

### 7.1 Session group

#### `session.describe`  *(no session required)*
Returns the agent's protocol/version/capabilities **without** opening a session — used for cheap discovery.

Request: `{ "method": "session.describe" }` (no params).
Result:
```json
{
  "ok": true,
  "protocolVersion": "1.0",
  "supportedProtocols": ["1.0"],
  "agent": { "name": "mc-test-driver-headless", "version": "0.4.2", "kind": "headlessBot" },
  "capabilities": ["command", "containerGui", "worldTruth"]
}
```

#### `session.ping`  *(no session required)*
Liveness/latency probe through the dispatch loop. Request params optional `{ "nonce": "abc" }`. Result `{ "ok": true, "nonce": "abc", "serverTick": 12345 }`.

#### `session.create`
See §4.2–§4.3 and §5.

#### `session.close`
See §4.4.

#### `world.join`
Joins/attaches the agent to the target. Available to any world-capable agent (bot/client); a no-op for server-side agents.

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "world.join",
  "params": {
    "sessionId": "s_7f3c1a",
    "host": "127.0.0.1",
    "port": 25565,
    "username": "Tester01",
    "auth": "offline",
    "world": "default",
    "joinTimeoutMs": 30000
  }
}
```

| Param | Req? | Meaning |
|---|---|---|
| `host` / `port` | yes (bot/client) | Server socket. For server-side agents these are ignored. |
| `username` | no | Offline-mode player name to join as. Default agent-assigned (e.g. `mctp-bot`). |
| `auth` | no | `"offline"` (default; matches `online-mode=false` provisioning) \| `"microsoft"` (token supplied out-of-band). |
| `world` | no | Logical world/dimension hint for the initial spawn. |
| `joinTimeoutMs` | no | Max time to reach the play state. |

Result:
```json
{
  "ok": true,
  "playerName": "Tester01",
  "playerUuid": "069a79f4-44e9-4726-a5be-fca90e38aaf5",
  "dimension": "minecraft:overworld",
  "position": { "x": 0.5, "y": 64.0, "z": 0.5 },
  "serverBrand": "Paper"
}
```
Transitions session **Ready → Connected**. For `serverPlugin`/`serverMod`, returns immediately with the agent's host context and the same shape (player fields may be null).

#### `world.leave`
Leaves the world / detaches. Available to any world-capable agent (the counterpart to `world.join`). Params `{ "sessionId": "...", "reason": "testTeardown" }`. Result `{ "ok": true }`. Transitions **Connected → Ready**. Does not end the session.

---

### 7.2 Input group

All input commands that address UI use a **semantic selector** (§7.3.1, grammar in `SELECTORS.md`). None accept raw coordinates or slot indices as primary addressing; an agent MAY accept a low-level escape hatch only behind a non-default capability (out of scope for `1.0`).

#### `world.runCommand`  *(cap `command`)*
Executes a slash command as the player (client→server command). The leading `/` is optional.

```json
{ "method": "world.runCommand", "params": { "sessionId": "s_7f3c1a", "command": "or", "expectChat": false } }
```
| Param | Req? | Meaning |
|---|---|---|
| `command` | yes | Command line without or with leading `/`. |
| `args` | no | Optional array appended with spaces (convenience; `command` may already be complete). |
| `expectChat` | no | If `true`, the agent includes the next system chat line (if any within `timeoutMs`) in `result.chat`. This is a convenience snapshot, **not** a substitute for `chat` assertions. |

Result `{ "ok": true, "screenChanged": true }` (e.g. `/or` opened a GUI). If `expectChat`, may include `result.chat: { "text": "...", "rawJson": "..." }`.

#### `world.sendChat`  *(cap `chat`)*
Sends a chat message (not a command). Params `{ "sessionId", "message": "hello" }`. Result `{ "ok": true }`.

#### `screen.pressKey`  *(cap `pressKey`)*
Presses/holds a logical key or key-bound action. Client-side only.
```json
{ "method": "screen.pressKey", "params": { "sessionId": "s_7f3c1a", "key": "inventory", "action": "press" } }
```
| Param | Meaning |
|---|---|
| `key` | A logical key name (`"escape"`, `"enter"`, `"e"`, `"f3"`) **or** a Minecraft keybinding id (`"key.inventory"`). |
| `action` | `"press"` (down+up, default) \| `"down"` \| `"up"`. |
| `modifiers` | optional array, e.g. `["shift"]`. |
Result `{ "ok": true, "screenChanged": true }`.

#### `screen.clickElement`  *(cap `containerGui` for container GUIs or `clientScreens` for client screens)*
Clicks the element resolved by a **semantic selector**. **This is the central UI primitive.** See §7.3.1 for the selector object and §11 for the regions example.
```json
{
  "method": "screen.clickElement",
  "params": {
    "sessionId": "s_7f3c1a",
    "selector": { "label": "Regions" },
    "button": "left",
    "clickType": "single"
  }
}
```
| Param | Req? | Meaning |
|---|---|---|
| `selector` | yes | Semantic selector object (§7.3.1 / `SELECTORS.md`). The **agent** resolves it to a concrete slot/widget; resolution strategy is the agent's, addressing intent is semantic. |
| `button` | no | `"left"` (default) \| `"right"` \| `"middle"`. |
| `clickType` | no | `"single"` (default) \| `"double"` \| `"shift"` \| `"hold"`. For container GUIs, `"shift"` maps to shift-click (quick-move). |
| `expectScreenChange` | no | If `true`, the agent waits up to `timeoutMs` for a screen/window transition and reports it; if no change occurs it still returns success with `screenChanged:false` (the runner decides if that is a failure). |

Result:
```json
{ "ok": true, "screenChanged": true, "resolved": { "via": "label", "slot": 11, "screenId": "regions:list" } }
```
- `result.resolved.via` — which selector key actually matched (audit trail).
- `result.resolved.slot` (inventory) or `result.resolved.widgetId` (client screen) — the concrete target chosen, for diagnostics only.
- If **no** element matches → error `-32000 ELEMENT_NOT_FOUND`; if **>1** match and the selector is not disambiguated (`nth`/`index`) → error `-32001 AMBIGUOUS_SELECTOR` (§9.3).

#### `screen.typeText`  *(cap `typeText`)*
Types text into the currently focused text input (anvil rename, sign, book, search box, command suggestion field). Optionally targets a field by selector first.
```json
{ "method": "screen.typeText", "params": { "sessionId": "s_7f3c1a", "selector": { "role": "input" }, "text": "TestRegion", "submit": false, "clear": true } }
```
| Param | Req? | Meaning |
|---|---|---|
| `text` | yes | Text to type. |
| `selector` | no | If present, the agent focuses the matching text field first (semantic). If absent, types into current focus. |
| `clear` | no | If `true`, clears existing content first. |
| `submit` | no | If `true`, presses Enter after typing. |
Result `{ "ok": true, "screenChanged": false }`.

#### `screen.close`  *(cap `containerGui` for container GUIs; `clientScreens` for client screens)*
Closes the currently open screen/GUI (the semantic equivalent of pressing Escape), returning to the world/HUD.
```json
{ "method": "screen.close", "params": { "sessionId": "s_7f3c1a" } }
```
Result `{ "ok": true, "screenChanged": true }`. If no screen is open, the agent returns success with `screenChanged:false`.

#### `useItem`  *(extension method — non-canon; gated by an agent `input.item` extension capability)*
Uses/activates an item or interacts with the world/block in front of the player (right-click semantics). Selector chooses the **hotbar/inventory item** to hold first when given.
```json
{ "method": "useItem", "params": { "sessionId": "s_7f3c1a", "selector": { "itemType": "minecraft:clock" }, "target": "self" } }
```
| Param | Meaning |
|---|---|
| `selector` | optional item selector to equip to main hand before use. |
| `target` | `"self"` (use item) \| `"block"` (interact with looked-at block) \| `"entity"`. |
| `hand` | `"main"` (default) \| `"off"`. |
Result `{ "ok": true, "screenChanged": true }` (e.g., a clock item that opens a menu).

#### `move`  *(extension method — non-canon; gated by an agent `input.move` extension capability)*
Moves/positions the player. Primitive movement only; pathfinding is the runner/driver's concern.
```json
{ "method": "move", "params": { "sessionId": "s_7f3c1a", "mode": "lookAt", "target": { "x": 10, "y": 64, "z": -3 } } }
```
| Param | Meaning |
|---|---|
| `mode` | `"walkTo"` (driver may pathfind) \| `"teleport"` (only if permitted) \| `"lookAt"` \| `"strafe"` \| `"jump"`. |
| `target` | block/entity position `{x,y,z}` or `{ "entityId": "..." }` depending on `mode`. |
| `yaw` / `pitch` | optional explicit look angles for `lookAt`. |
Result `{ "ok": true, "position": { "x": 9.5, "y": 64.0, "z": -2.5 }, "yaw": 90.0, "pitch": 0.0 }`.

---

### 7.3 Query group

Query commands are **read-only snapshots**. They never mutate game state and never block beyond `timeoutMs`.

#### 7.3.1 The semantic selector object (wire shape)

`screen.listElements`, `screen.clickElement`, `screen.typeText`, and item-bearing inputs accept a **selector** object. MCTP pins the wire **shape**; matching semantics, normalization, and precedence are defined in [`SELECTORS.md`](./SELECTORS.md). The recognized keys (all OPTIONAL individually; at least one MUST be present) are:

| Key | Type | Intent (full semantics in `SELECTORS.md`) |
|---|---|---|
| `label` | string | Exact visible display name (item display name / widget message). |
| `text` | string | Exact visible text match. |
| `textContains` | string | Substring / contains match against visible text. |
| `loreContains` | string \| string[] | Match against item lore lines (contains). |
| `itemType` | string | Minecraft item id `namespace:path` (e.g. `minecraft:diamond_sword`). |
| `role` | string | Semantic role from the enum: `"button"` \| `"slot"` \| `"label"` \| `"input"` \| `"tab"` \| `"list"` \| `"listItem"`. |
| `index` / `nth` | number | 0-based disambiguator among matches (`nth` = ordinal within filtered set). |
| `within` | selector | Scope: match only inside the element/region matched by this nested selector. |
| `testId` | string | An invisible stable id emitted by SUTs we control (NBT tag / data component / widget id). **Most robust**; see §7.3.2. |

The selector object is a logical **AND** of its present keys (an element must satisfy all). Disambiguation via `nth`/`index` is applied after filtering. Example: `{ "text": "Region", "role": "button", "within": { "testId": "regions:list" }, "nth": 0 }`.

> The protocol does not interpret these keys beyond passing them to the agent's resolver and surfacing which key matched (`result.resolved.via`). This keeps selector evolution in `SELECTORS.md` without bumping MCTP.

#### 7.3.2 `testId` injection (for SUTs we control)

Agents SHOULD resolve `testId` from the canonical `testId` carriers:
- **Inventory items**: the custom NBT key `mctp:testId` (≤ 1.20.4) or the data component `mc-test:test_id` (≥ 1.20.5, carried under `minecraft:custom_data`) on the `ItemStack`.
- **Client widgets**: a widget id string the SUT mod assigns (the client agent reads it from the widget instance / a marker interface).

This is the most robust selector and is RECOMMENDED for the canonical `regions` example's own buttons (`testId: "regions:list"`, `testId: "regions:entry:TestRegion"`).

#### `screen.get`  *(cap `clientScreens` for client Screens; `containerGui` for container GUIs)*
Returns a snapshot of the **active** screen/GUI as a normalized element list (and optional tree).
```json
{ "method": "screen.get", "params": { "sessionId": "s_7f3c1a", "includeTree": true, "includeInvisible": false } }
```
Result:
```json
{
  "ok": true,
  "screen": {
    "screenId": "regions:list",
    "kind": "containerGui",
    "title": "Regions",
    "titleRaw": "{\"text\":\"Regions\"}",
    "size": { "rows": 6, "cols": 9 },
    "elements": [
      {
        "elementId": "el_11",
        "role": "listItem",
        "label": "TestRegion",
        "text": "TestRegion",
        "itemType": "minecraft:filled_map",
        "lore": ["Click to load"],
        "testId": "regions:entry:TestRegion",
        "slot": 11,
        "enabled": true,
        "visible": true
      }
    ]
  }
}
```
- `screen.kind` ∈ `{ "containerGui", "clientScreen", "hud", "none" }`.
- `screen.screenId` — a stable id for the current screen when derivable (window title / SUT testId / screen class). May be `null`.
- Each element carries the data fields the selector keys match against — `label`, `text` (matched by `text`/`textContains`), `lore` (matched by `loreContains`), `itemType`, `role`, `testId` — plus `elementId` (ephemeral handle valid for this snapshot), `slot` (container) or `bounds` (client screen, in GUI-space pixels, diagnostic only), `enabled`, `visible`.
- `none` kind means no GUI is open (just the world/HUD).

#### `screen.listElements`  *(cap as `screen.get`)*
Like `screen.get` but **filtered by a selector** — returns only matching elements. This is the query twin of `screen.clickElement`'s resolution and is how the runner inspects/asserts before clicking.
```json
{ "method": "screen.listElements", "params": { "sessionId": "s_7f3c1a", "selector": { "role": "listItem", "within": { "testId": "regions:list" } } } }
```
Result `{ "ok": true, "count": 1, "elements": [ { "elementId": "el_11", "label": "TestRegion", "testId": "regions:entry:TestRegion", "slot": 11, ... } ] }`. Empty match → `{ "ok": true, "count": 0, "elements": [] }` (NOT an error; absence is a valid query answer).

#### `screen.waitForScreen`  *(cap `clientScreens` for client Screens; `containerGui` for container GUIs)*
Blocks up to `timeoutMs` for a screen/window transition to a screen matching the given criteria, then returns the resulting screen snapshot. This is the single-primitive await that lets the runner avoid busy-polling `screen.get`; poll-until/retry policy still lives in the runner (§9.4), but this bounded wait is a convenience the agent honors against the game thread.
```json
{ "method": "screen.waitForScreen", "params": { "sessionId": "s_7f3c1a", "match": { "screenIdPrefix": "regions:", "kind": "containerGui" }, "change": "opened", "timeoutMs": 5000 } }
```
| Param | Req? | Meaning |
|---|---|---|
| `match` | no | Criteria for the target screen: `screenId`, `screenIdPrefix`, `kind`, or `title`. Omit to await any transition. |
| `change` | no | `"opened"` (default) \| `"closed"` \| `"replaced"`. |
Result `{ "ok": true, "screen": { "screenId": "regions:list", "kind": "containerGui", "title": "Regions", ... } }`. If no matching transition occurs within `timeoutMs` → `-32003 TIMEOUT`.

#### `getWindow`  *(extension method — non-canon; gated by the canon `containerGui` capability)*
Container-GUI-specialized snapshot: returns the open **container window** (chest/menu/anvil) with slot grid, the player inventory slots, the carried (cursor) stack, and window metadata. Use when the runner needs slot-level fidelity (counts, NBT) rather than the abstract element list.
```json
{ "method": "getWindow", "params": { "sessionId": "s_7f3c1a" } }
```
Result:
```json
{
  "ok": true,
  "window": {
    "windowId": 3,
    "type": "minecraft:generic_9x6",
    "title": "Regions",
    "slots": [
      { "slot": 11, "itemType": "minecraft:filled_map", "count": 1, "displayName": "TestRegion",
        "lore": ["Click to load"], "testId": "regions:entry:TestRegion" }
    ],
    "playerSlots": [],
    "carried": null
  }
}
```
If no container window is open → `{ "ok": true, "window": null }`.

#### `truth.getWorldBlock`  *(cap `worldTruth`)*
Reads authoritative block state from the **server** (via the server agent), not the client's render.
```json
{ "method": "truth.getWorldBlock", "params": { "sessionId": "s_7f3c1a", "world": "world", "x": 100, "y": 64, "z": -200 } }
```
Result:
```json
{
  "ok": true,
  "block": {
    "type": "minecraft:oak_sign",
    "properties": { "rotation": "8" },
    "nbtJson": "{\"Text1\":\"{\\\"text\\\":\\\"TestRegion\\\"}\"}",
    "biome": "minecraft:plains"
  }
}
```
`world` defaults to the player's current world. Out-of-range/unloaded → error `-32004 WORLD_NOT_READY` (with `data.reason`).

#### `truth.getEntities`  *(cap `worldTruth`)*
Lists entities near a point (server truth).
```json
{ "method": "truth.getEntities", "params": { "sessionId": "s_7f3c1a", "world": "world", "center": { "x": 0, "y": 64, "z": 0 }, "radius": 16, "type": "minecraft:armor_stand" } }
```
Result:
```json
{
  "ok": true,
  "count": 1,
  "entities": [
    { "id": "e_31:982", "uuid": "…", "type": "minecraft:armor_stand", "name": "TestRegion Marker",
      "position": { "x": 1.0, "y": 64.0, "z": 1.0 }, "tags": ["regions_marker"], "customNameRaw": "{\"text\":\"TestRegion Marker\"}" }
  ]
}
```
`radius` MUST be ≤ the granted `worldTruth.radiusLimit`; exceeding it → `-32602 invalidParams`.

#### `getPlayerState`  *(extension method — non-canon; gated by an agent `player.state` extension capability)*
Snapshot of the (agent's) player or, for the server agent, a named player.
```json
{ "method": "getPlayerState", "params": { "sessionId": "s_7f3c1a", "player": "Tester01" } }
```
Result:
```json
{
  "ok": true,
  "player": {
    "name": "Tester01",
    "uuid": "069a79f4-44e9-4726-a5be-fca90e38aaf5",
    "dimension": "minecraft:overworld",
    "position": { "x": 0.5, "y": 64.0, "z": 0.5 },
    "yaw": 0.0, "pitch": 0.0,
    "health": 20.0, "food": 20, "gameMode": "survival",
    "heldSlot": 0,
    "openScreenId": "regions:list"
  }
}
```
`player` param is optional for self-aware agents (bot/client); REQUIRED for a server agent querying a specific player.

#### `getLogs`  *(extension method — non-canon; gated by an agent `logs.read` extension capability)*
Pulls buffered log lines (server console or client log) by filter. Pull-based twin of the `event.log` event.
```json
{ "method": "getLogs", "params": { "sessionId": "s_7f3c1a", "source": "server", "sinceSeq": 0, "contains": "Region", "level": "INFO", "limit": 200 } }
```
| Param | Meaning |
|---|---|
| `source` | `"server"` \| `"client"`. |
| `sinceSeq` | return lines with `seq >` this (cursor). |
| `contains` / `regex` | filter. |
| `level` | minimum level: `TRACE`<`DEBUG`<`INFO`<`WARN`<`ERROR`. |
| `limit` | max lines returned. |
Result:
```json
{ "ok": true, "lines": [ { "seq": 4412, "tsMs": 1718412345678, "level": "INFO", "logger": "RegionsPlugin", "message": "Region loaded: TestRegion", "thread": "Server thread" } ], "nextSeq": 4413 }
```

---

### 7.4 Capture group

#### `screen.screenshot`  *(cap `screenshot`)*
Captures the current rendered frame (client mod) or framebuffer (pixel driver). Returns inline base64 **or** a reference (§8.1).
```json
{ "method": "screen.screenshot", "params": { "sessionId": "s_7f3c1a", "format": "png", "return": "ref", "region": "screen", "maxWidth": 1280 } }
```
| Param | Meaning |
|---|---|
| `format` | `"png"` (default; must be in `capability.formats`). |
| `return` | `"inline"` (base64 in result) \| `"ref"` (artifact reference; default for large frames). |
| `region` | `"screen"` (default) \| `"gui"` (just the open GUI bounds). |
| `maxWidth`/`maxHeight` | downscale cap. |
Result (inline):
```json
{ "ok": true, "image": { "format": "png", "width": 1280, "height": 720, "encoding": "base64", "data": "iVBORw0KGgo…" } }
```
Result (ref):
```json
{ "ok": true, "image": { "format": "png", "width": 1280, "height": 720, "ref": "artifact://s_7f3c1a/shot_017.png" } }
```
Server-side / headless agents that lack a render surface MUST NOT advertise `screenshot`; if called anyway → `-32002 METHOD_NOT_SUPPORTED`.

---

### 7.5 Fixtures group (server agent)

Fixtures let the runner deterministically shape the world/plugin before/after a test. They require server-side authority and are advertised only by `serverPlugin`/`serverMod` agents.

#### `fixture.reset`  *(cap `fixtures`)*
Restores the world to a pristine snapshot (the per-test isolation primitive; pairs with the provisioning's "copy a pristine world snapshot per test").
```json
{ "method": "fixture.reset", "params": { "sessionId": "s_7f3c1a", "snapshot": "regions-baseline", "world": "world" } }
```
| Param | Meaning |
|---|---|
| `snapshot` | named snapshot to restore (provisioned out-of-band). Omit to reset to the world's original on-disk state. |
| `world` | which world; default all loaded worlds for the target. |
| `regenerate` | optional bool: regenerate chunks rather than copy snapshot. |
Result `{ "ok": true, "restored": "regions-baseline", "tookMs": 812 }`.

#### `fixture.set`  *(cap `fixtures`)*
Applies a named, parameterized fixture (place blocks, create a region, give items, set a config value). Fixtures are SUT-defined recipes the agent knows how to apply; the protocol just routes name+params.
```json
{
  "method": "fixture.set",
  "params": {
    "sessionId": "s_7f3c1a",
    "fixture": "regions.createRegion",
    "args": { "name": "TestRegion", "min": { "x": 0, "y": 60, "z": 0 }, "max": { "x": 16, "y": 80, "z": 16 } }
  }
}
```
Result:
```json
{ "ok": true, "fixture": "regions.createRegion", "applied": true, "handle": "fx_region_TestRegion", "result": { "regionId": "TestRegion" } }
```
- `handle` — an opaque id the runner MAY pass to a later `fixture.set("core.undo", {handle})` or rely on `session.close`/`fixture.reset` cleanup.
- Unknown fixture name or a recipe that fails to apply → `-32005 FIXTURE_FAILED`; bad args → `-32602 invalidParams`.

#### `player.spawnFake`  *(cap `fakePlayers`)*
Spawns a server-side fake/bot player (Carpet `/player` or native), e.g. to test multiplayer plugin behavior without a second real client.
```json
{ "method": "player.spawnFake", "params": { "sessionId": "s_7f3c1a", "name": "Bystander", "at": { "x": 2, "y": 64, "z": 2 }, "gameMode": "survival" } }
```
Result `{ "ok": true, "name": "Bystander", "uuid": "…", "handle": "fp_Bystander" }`. The agent MUST track and despawn fake players it created on `session.close`.

#### `player.despawnFake`  *(cap `fakePlayers`)*
Despawns a fake/bot player previously created by `player.spawnFake`, addressed by its `handle` (or `name`).
```json
{ "method": "player.despawnFake", "params": { "sessionId": "s_7f3c1a", "handle": "fp_Bystander" } }
```
Result `{ "ok": true, "despawned": "fp_Bystander" }`. Unknown handle → `-32602 invalidParams`. The agent also despawns any remaining fake players automatically on `session.close`.

#### `truth.assertPluginState`  *(cap `pluginState`)*
Reads authoritative plugin/mod state for assertions (the server-truth twin of GUI assertions). **The agent only fetches/evaluates a named state query; it does not decide pass/fail policy** — it returns the value plus a boolean for the supplied predicate, and the runner owns the verdict and reporting.
```json
{
  "method": "truth.assertPluginState",
  "params": {
    "sessionId": "s_7f3c1a",
    "query": "regions.exists",
    "args": { "name": "TestRegion" },
    "expect": { "equals": true }
  }
}
```
| Param | Meaning |
|---|---|
| `query` | SUT-registered state query name (the plugin/agent exposes a small registry of read-only probes). |
| `args` | query arguments. |
| `expect` | optional predicate the agent evaluates against the value: one of `equals`, `notEquals`, `contains`, `gt`, `gte`, `lt`, `lte`, `exists`. If omitted, the agent just returns the value and `matched` is `null`. |
Result:
```json
{ "ok": true, "query": "regions.exists", "value": true, "matched": true, "valueJson": "true" }
```
- `value` — the typed value (also `valueJson` for fidelity).
- `matched` — `true`/`false` if `expect` was supplied, else `null`.
- Unknown query (or a probe that fails to evaluate) → `-32006 ASSERT_FAILED`.

> Even though `truth.assertPluginState` evaluates a predicate, the **assertion verdict, retry, and failure artifact** belong to the runner (prime directive: intelligence lives outside the game). The agent returns facts; the runner asserts.

---

### 7.6 Events / streams group

The canonical wait primitives are `world.waitForChat` (below) and `screen.waitForScreen` (§7.3): each blocks up to `timeoutMs` for a single matching occurrence and returns it. The server also pushes `event.*` notifications (§3.6) — `event.chat`, `event.screenChanged`, `event.log`, and `event.disconnected`. The opt-in `subscribe`/`unsubscribe` stream machinery is an **agent extension** (non-canon) for clients that prefer a continuous push stream over discrete awaits; it reuses the same `event.*` notification payloads.

#### `world.waitForChat`  *(cap `chat`)*
Blocks up to `timeoutMs` for the next chat line matching `filter`, then returns it. The single-primitive await twin of the `event.chat` stream — how the canonical test asserts "chat contains `Region loaded`" without polling. (Retry/verdict policy still lives in the runner, §9.4.)
```json
{ "method": "world.waitForChat", "params": { "sessionId": "s_7f3c1a", "filter": { "contains": "Region", "channel": "system" }, "timeoutMs": 5000 } }
```
| Param | Req? | Meaning |
|---|---|---|
| `filter` | no | Same chat filter keys as the `event.chat` stream: `contains`, `regex`, `channel`, `sender`. Omit to match the next chat line. |
Result `{ "ok": true, "chat": { "text": "Region loaded: TestRegion", "rawJson": "{...}", "sender": "server", "channel": "system" } }`. If no matching line arrives within `timeoutMs` → `-32003 TIMEOUT`.

#### `subscribe`  *(extension method — non-canon; per-stream gate, e.g. canon `chat` for the `chat` stream)*
```json
{
  "method": "subscribe",
  "params": {
    "sessionId": "s_7f3c1a",
    "stream": "chat",
    "filter": { "contains": "Region", "channel": "system" },
    "replaySinceSeq": 0,
    "overflow": "dropOldest"
  }
}
```
| Param | Meaning |
|---|---|
| `stream` | `"chat"` \| `"log"` \| `"screenChanged"`. |
| `filter` | stream-specific server-side filter (reduces traffic; see below). |
| `replaySinceSeq` | if the agent buffers history, replay events with `seq >` this immediately upon subscribe (closes the subscribe-race window). `0` = from now. |
| `overflow` | buffer-overflow policy when the client is slow: `"dropOldest"` (default) \| `"dropNewest"` \| `"disconnect"`. |
Result:
```json
{ "ok": true, "subscriptionId": "sub_chat_1", "stream": "chat", "currentSeq": 127 }
```

After subscribing, the agent pushes notifications:
```json
{ "jsonrpc": "2.0", "method": "event.chat",
  "params": { "sessionId": "s_7f3c1a", "subscriptionId": "sub_chat_1", "seq": 128, "tsMs": 1718412345678,
    "data": { "text": "Region loaded", "rawJson": "{\"text\":\"Region loaded\",\"color\":\"green\"}", "sender": "server", "channel": "system" } } }
```

#### `unsubscribe`
```json
{ "method": "unsubscribe", "params": { "sessionId": "s_7f3c1a", "subscriptionId": "sub_chat_1" } }
```
Result `{ "ok": true }`. The agent MUST stop emitting for that `subscriptionId`; in-flight events the client still receives MUST be dropped client-side (§3.6).

#### Event stream payloads

**`event.chat`** (`data`):
| Field | Meaning |
|---|---|
| `text` | flattened plain text of the chat component. |
| `rawJson` | the raw Minecraft text-component JSON (for color/format-sensitive assertions). |
| `sender` | `"server"` \| `"player"` \| player name. |
| `channel` | `"system"` \| `"chat"` \| `"actionBar"` \| `"gameInfo"`. |
Filter keys: `contains`, `regex`, `channel`, `sender`.

**`event.log`** (`data`): `{ "level", "logger", "message", "thread" }`. Filter keys: `contains`, `regex`, `level`, `logger`, `source` (`"server"`/`"client"`).

**`event.screenChanged`** (`data`):
| Field | Meaning |
|---|---|
| `change` | `"opened"` \| `"closed"` \| `"replaced"`. |
| `screenId` | new active screen id (or `null` if closed to world). |
| `kind` | `"containerGui"` \| `"clientScreen"` \| `"hud"` \| `"none"`. |
| `title` | new screen title (plain). |
Filter keys: `kind`, `screenIdPrefix`. This event lets the runner await GUI transitions instead of busy-polling `screen.get`.

**`event.disconnected`** (`data`): emitted when the agent loses its world/server connection unexpectedly (kick, server stop, network drop). `{ "reason", "code", "graceful" }` — `reason` is a human string, `graceful` is `true` for a clean `world.leave`-style detach and `false` for an unexpected drop. Carries no `subscriptionId` (it is a session-scoped, always-on lifecycle event, not a stream subscription).

---

## 8. Artifacts and large payloads

### 8.1 Artifact references (`ref`)

Large or binary outputs (screenshots, optional video, big log dumps) MAY be returned **by reference** to keep frames small:

- A `ref` is a URI `artifact://<sessionId>/<name>` (agent-local) or an `http(s)://`/`file://` URL the runner can fetch.
- The runner resolves `artifact://` either by a side-channel HTTP endpoint the agent exposes, or — in the common single-host CI case — by a shared artifacts directory the provisioning mounts. The mapping is deployment config, not protocol; the protocol only guarantees the `ref` string is stable for the session's lifetime and points at the named bytes.
- Artifacts are reaped at `session.close` unless the runner has copied them into the JUnit/report bundle.

### 8.2 Reporting alignment (informative)

MCTP itself produces no reports; the runner maps protocol results/events/artifacts into **JUnit XML** plus a per-failure bundle (screenshots via `screen.screenshot`, logs via `getLogs`/`event.log`, optional video). Field names like `rawJson`, `serverTick`, and `ref` exist specifically so the reporter can attach high-fidelity evidence.

---

## 9. Error model

### 9.1 Structure

All errors use the JSON-RPC 2.0 error object. MCTP standardizes `error.data`:

| `data` field | Type | Meaning |
|---|---|---|
| `reason` | string | A stable machine token (table §9.2/§9.3); mirrors the numeric `code`. **Clients branch on `reason`, not on `message`.** |
| `retryable` | boolean | `true` if the same request might succeed on retry (transient: timeout, not-yet-loaded). `false` for deterministic failures (unknown method, capability denied, ambiguous selector). |
| `details` | object | Free-form, error-specific context (e.g. `selector`, `screenId`, `constraint`, `candidatesConsidered`). |
| `sessionId` | string | Echoed when applicable. |
| `requestId` | string | Echoed client trace tag, if supplied. |

`message` is human-readable and MUST NOT be parsed by clients.

### 9.2 Reserved JSON-RPC range and protocol errors

JSON-RPC's predefined codes are used as-is:

| Code | `reason` | Meaning |
|---|---|---|
| `-32700` | `parseError` | Invalid JSON. |
| `-32600` | `invalidRequest` | Not a valid envelope (e.g. missing `jsonrpc`); also used for a request referencing an invalid/closed session. |
| `-32601` | `methodNotFound` | Unknown method. |
| `-32602` | `invalidParams` | Params fail MCTP schema/semantics (also covers a missing/unknown/closed `sessionId`). |
| `-32603` | `internalError` | Unexpected agent-side failure not otherwise classified. |

MCTP-specific errors occupy exactly the following codes in the implementation-defined server range `-32000 … -32099`:

| Code | `reason` | `retryable` | Meaning |
|---|---|---|---|
| `-32000` | `ELEMENT_NOT_FOUND` | true | Selector matched zero elements (or the matched element is disabled/invisible/out of view). `data.details.selector`, `screenId`, `candidatesConsidered`. |
| `-32001` | `AMBIGUOUS_SELECTOR` | false | Selector matched >1 element without `nth`/`index`. `data.details.matches` (slot/widget list). |
| `-32002` | `METHOD_NOT_SUPPORTED` | false | Method/feature not implemented by this agent build, or requires a capability not in `grantedCapabilities`. |
| `-32003` | `TIMEOUT` | true | `timeoutMs` elapsed before the primitive completed. |
| `-32004` | `WORLD_NOT_READY` | true | The world/GUI/screen needed isn't ready: not yet joined (Ready, not Connected), block/chunk/world not loaded or out of range, or the required screen isn't open. `data.details` carries `expected`/`actual` where relevant. |
| `-32005` | `FIXTURE_FAILED` | false | A fixture could not be applied/reset (unknown fixture name, or the recipe failed). |
| `-32006` | `ASSERT_FAILED` | false | A plugin-state probe could not be evaluated (unknown state query, or evaluation failed). |
| `-32099` | `PROTOCOL_VERSION_UNSUPPORTED` | false | The requested `protocolVersion` major is not supported (handshake). |

### 9.3 Negotiation outcomes and command-level mapping

- **Protocol-version mismatch** at `session.create` → `-32099 PROTOCOL_VERSION_UNSUPPORTED`.
- **Missing required capabilities / unsatisfiable constraints** at `session.create`: the agent refuses with a JSON-RPC error whose `data` lists what is missing in `data.unmet[]` (and what it offers in `data.offered`); **no session is created**. The runner maps this refusal to a **skip** with the runner-level reason `NO_COMPATIBLE_DRIVER` (carrying `unmet[]`). `NO_COMPATIBLE_DRIVER` is a runner/JUnit outcome token, not a wire error code (§5.3).
- **Command-level conditions** map onto the canonical codes above: no element → `-32000 ELEMENT_NOT_FOUND`; ambiguous match → `-32001 AMBIGUOUS_SELECTOR`; ungranted/unsupported method → `-32002 METHOD_NOT_SUPPORTED`; primitive overran `timeoutMs` → `-32003 TIMEOUT`; world/GUI not ready → `-32004 WORLD_NOT_READY`; fixture problem → `-32005 FIXTURE_FAILED`; plugin-state probe problem → `-32006 ASSERT_FAILED`.

Agents MUST choose the **most specific** canonical code. Clients MUST treat any unknown `-32000…-32099` code as a non-fatal agent error and consult `data.retryable`.

### 9.4 Timeouts and retries (policy lives in the runner)

The protocol provides only a per-call `timeoutMs` and a `retryable` hint. **Poll-until, exponential backoff, and stale-retry loops are implemented by the runner**, composing primitives. Example: the runner clicks `Regions`, then loops `screen.listElements({within: regions:list})` until non-empty or a wall-clock budget expires, then asserts — all out-of-game.

---

## 10. Protocol versioning

- **Identifier.** The negotiated handshake value is the `protocolVersion` string `"<major>.<minor>"` (starting at `"1.0"`). The protocol's human-readable identifier is `mctp/<major>.<minor>` (e.g. `mctp/1.0`), and the WebSocket sub-protocol token tracks **major** only (`mctp.v1`).
- **Compatibility.** Within a major version, changes are **additive and backward-compatible**: new optional params, new result fields, new methods, new capability keys, new error codes. Clients MUST ignore unknown result/event fields; agents MUST ignore unknown optional params (and MUST NOT fault on them).
- **Negotiation.** `session.create.protocolVersion` states the client's exact version; the agent advertises `supportedProtocols` (via `session.describe`) and the chosen `protocolVersion` in the handshake result. If majors differ → `-32099 PROTOCOL_VERSION_UNSUPPORTED`. If the client's minor exceeds the agent's, the agent MUST still accept (it simply ignores unknown optional inputs) and report its own lower minor in `result.protocolVersion`; the client downgrades expectations to that minor.
- **Breaking changes** require a major bump (`mctp/2.0`, sub-protocol `mctp.v2`); an agent MAY serve multiple majors on distinct sub-protocol tokens.
- **Capability versioning** is orthogonal: a capability surface evolves via its `capabilityDetails[key].version` integer without bumping the protocol version. This lets one driver gain features against many protocol minors.

---

## 11. Worked example — the canonical `regions` flow

Test (authored once): **join localhost → `/or` → click "Regions" → click "TestRegion" → assert chat contains "Region loaded" AND (via the server agent) region "TestRegion" exists.**

The runner uses **two** MCTP sessions against the same matrix target: a UI session (headless bot or client mod) and a server-agent session (Bukkit plugin) for world-truth. Below shows the wire traffic. JSON-RPC `id`s are per-connection.

### 11.1 Handshake (UI session — headless bot)

→ request
```json
{ "jsonrpc": "2.0", "id": 1, "method": "session.create",
  "params": { "protocolVersion": "1.0", "client": { "name": "mc-test-runner", "version": "0.4.2", "lang": "ts" },
    "requiredCapabilities": ["command", "containerGui", "chat", "testIdTags"],
    "optionalCapabilities": ["clientScreens"],
    "constraints": { "mcVersionRange": "1.20.4", "loader": "paper" } } }
```
← response
```json
{ "jsonrpc": "2.0", "id": 1, "result": { "ok": true, "sessionId": "s_ui_01", "protocolVersion": "1.0",
    "agent": { "name": "mc-test-driver-headless", "version": "0.4.2", "kind": "headlessBot", "lang": "ts" },
    "target": { "minecraft": "1.20.4", "protocolVersion": 765, "loader": "paper", "viaVersion": true },
    "grantedCapabilities": ["command", "containerGui", "chat", "testIdTags"],
    "deniedCapabilities": ["clientScreens"], "capabilityDetails": { "containerGui": { "version": 1, "screenModel": "containerSlots" } } } }
```

### 11.2 Handshake (server-agent session — Bukkit plugin)

→ request
```json
{ "jsonrpc": "2.0", "id": 1, "method": "session.create",
  "params": { "protocolVersion": "1.0", "client": { "name": "mc-test-runner", "version": "0.4.2", "lang": "ts" },
    "requiredCapabilities": ["worldTruth", "pluginState", "fixtures"],
    "constraints": { "loader": "paper" } } }
```
← response
```json
{ "jsonrpc": "2.0", "id": 1, "result": { "ok": true, "sessionId": "s_srv_01", "protocolVersion": "1.0",
    "agent": { "name": "mc-test-server-bukkit", "version": "0.4.2", "kind": "serverPlugin", "lang": "java" },
    "target": { "minecraft": "1.20.4", "loader": "paper", "loaderVersion": "1.20.4-R0.1" },
    "grantedCapabilities": ["worldTruth", "pluginState", "fixtures"],
    "deniedCapabilities": [], "capabilityDetails": { "pluginState": { "version": 1 } } } }
```

### 11.3 Fixture + connect

Server agent restores a pristine world and ensures the region exists (or the test will create it via the GUI — here we pre-seed to assert load):
```json
{ "jsonrpc": "2.0", "id": 2, "method": "fixture.reset", "params": { "sessionId": "s_srv_01", "snapshot": "regions-baseline" } }
```
← `{ "jsonrpc": "2.0", "id": 2, "result": { "ok": true, "restored": "regions-baseline", "tookMs": 740 } }`

UI session joins localhost:
```json
{ "jsonrpc": "2.0", "id": 2, "method": "world.join",
  "params": { "sessionId": "s_ui_01", "host": "127.0.0.1", "port": 25565, "username": "Tester01", "auth": "offline" } }
```
← `{ "jsonrpc": "2.0", "id": 2, "result": { "ok": true, "playerName": "Tester01", "playerUuid": "069a…", "dimension": "minecraft:overworld", "serverBrand": "Paper" } }`

### 11.4 Subscribe to chat (UI session)

This example uses the (extension) push-stream path; the canonical single-shot equivalent is one `world.waitForChat` call with the same `filter` after the click in §11.7.

```json
{ "jsonrpc": "2.0", "id": 3, "method": "subscribe",
  "params": { "sessionId": "s_ui_01", "stream": "chat", "filter": { "contains": "Region" }, "replaySinceSeq": 0 } }
```
← `{ "jsonrpc": "2.0", "id": 3, "result": { "ok": true, "subscriptionId": "sub_chat_1", "stream": "chat", "currentSeq": 0 } }`

### 11.5 Run `/or` → GUI opens

```json
{ "jsonrpc": "2.0", "id": 4, "method": "world.runCommand", "params": { "sessionId": "s_ui_01", "command": "or" } }
```
← `{ "jsonrpc": "2.0", "id": 4, "result": { "ok": true, "screenChanged": true } }`

Optional confirm of the open screen:
```json
{ "jsonrpc": "2.0", "id": 5, "method": "screen.get", "params": { "sessionId": "s_ui_01" } }
```
← (abridged)
```json
{ "jsonrpc": "2.0", "id": 5, "result": { "ok": true, "screen": { "screenId": "regions:root", "kind": "containerGui", "title": "OpenRegions",
  "elements": [ { "elementId": "el_4", "role": "button", "label": "Regions", "itemType": "minecraft:book", "testId": "regions:root:regions", "slot": 4, "enabled": true } ] } } }
```

### 11.6 Click "Regions" (semantic selector)

```json
{ "jsonrpc": "2.0", "id": 6, "method": "screen.clickElement",
  "params": { "sessionId": "s_ui_01", "selector": { "label": "Regions" }, "expectScreenChange": true } }
```
← `{ "jsonrpc": "2.0", "id": 6, "result": { "ok": true, "screenChanged": true, "resolved": { "via": "label", "slot": 4, "screenId": "regions:list" } } }`

### 11.7 Confirm the list, then click "TestRegion"

Query the list scoped by `testId` (most robust), then click:
```json
{ "jsonrpc": "2.0", "id": 7, "method": "screen.listElements",
  "params": { "sessionId": "s_ui_01", "selector": { "role": "listItem", "within": { "testId": "regions:list" } } } }
```
← `{ "jsonrpc": "2.0", "id": 7, "result": { "ok": true, "count": 1, "elements": [ { "elementId": "el_11", "label": "TestRegion", "testId": "regions:entry:TestRegion", "slot": 11 } ] } }`

```json
{ "jsonrpc": "2.0", "id": 8, "method": "screen.clickElement",
  "params": { "sessionId": "s_ui_01", "selector": { "testId": "regions:entry:TestRegion" }, "expectScreenChange": false } }
```
← `{ "jsonrpc": "2.0", "id": 8, "result": { "ok": true, "screenChanged": false, "resolved": { "via": "testId", "slot": 11, "screenId": "regions:list" } } }`

### 11.8 Chat event arrives (assert #1)

The agent pushes (no `id`):
```json
{ "jsonrpc": "2.0", "method": "event.chat",
  "params": { "sessionId": "s_ui_01", "subscriptionId": "sub_chat_1", "seq": 1, "tsMs": 1718412345678,
    "data": { "text": "Region loaded: TestRegion", "rawJson": "{\"text\":\"Region loaded: TestRegion\",\"color\":\"green\"}", "sender": "server", "channel": "system" } } }
```
The runner asserts `data.text` contains `"Region loaded"` → **pass #1**. (No protocol verdict; the runner decides.)

### 11.9 Server-truth assertion (assert #2)

```json
{ "jsonrpc": "2.0", "id": 3, "method": "truth.assertPluginState",
  "params": { "sessionId": "s_srv_01", "query": "regions.exists", "args": { "name": "TestRegion" }, "expect": { "equals": true } } }
```
← `{ "jsonrpc": "2.0", "id": 3, "result": { "ok": true, "query": "regions.exists", "value": true, "matched": true, "valueJson": "true" } }`

Runner asserts `matched === true` → **pass #2**. Both assertions pass ⇒ the test passes for this matrix cell.

### 11.10 Teardown

```json
{ "jsonrpc": "2.0", "id": 9, "method": "unsubscribe", "params": { "sessionId": "s_ui_01", "subscriptionId": "sub_chat_1" } }
{ "jsonrpc": "2.0", "id": 10, "method": "world.leave", "params": { "sessionId": "s_ui_01", "reason": "testTeardown" } }
{ "jsonrpc": "2.0", "id": 11, "method": "session.close", "params": { "sessionId": "s_ui_01" } }
```
Server agent:
```json
{ "jsonrpc": "2.0", "id": 4, "method": "session.close", "params": { "sessionId": "s_srv_01" } }
```
The runner emits one JUnit testcase (`regions.loadFromGui`) for this matrix cell, attaching any failure artifacts.

---

## 12. Implementation notes (TS client + Java agent)

These notes keep both reference implementations honest against the same contract.

### 12.1 Shared JSON shapes

- `/packages/protocol` owns the **single source of truth**: TypeScript types + **JSON Schema** for every `params`/`result`/`event.data`, generated to both `.d.ts` and Java POJOs (Jackson) so the TS client and Java agent serialize identically. Field names are exactly the `lowerCamelCase` keys in this doc.
- The Java agent (`/agents/core`) implements a `Dispatcher` mapping `method → handler(params): result`, plus an `EventBus` that emits `event.*` notifications. Per-loader shims (`/agents/client-fabric`, `-forge`, `-neoforge`, `/agents/server-bukkit`, `/agents/server-fabric`) only provide the **obfuscation-mapped primitives** (read widget tree, click slot, screenshot) behind interfaces; **all** routing, error mapping, and capability gating live in `core`.

### 12.2 Client (TypeScript) responsibilities

- One `WebSocket` per session; an outstanding-request map keyed by JSON-RPC `id`; a notification handler keyed by `subscriptionId`.
- The client implements **all** policy: driver selection (§5.2), poll-until/retry using `error.data.retryable` (§9.4), selector authoring (semantic objects), assertion verdicts, JUnit reporting, artifact collection.
- Never assume in-order responses; correlate by `id` (§3.7).

### 12.3 Agent (Java) responsibilities

- Bind WebSocket on a provisioned loopback port; accept sub-protocol `mctp.v1`; serve `/mctp`.
- Enforce the state machine (§4), capability gating (every advertised capability ⇒ its methods callable; ungranted ⇒ `-32002 METHOD_NOT_SUPPORTED`), and the error model (§9), choosing the most specific code.
- Run primitive handlers on the **game thread** when required (most UI/world reads), bounded by `timeoutMs`; never embed retries or assertions.
- Track and release per-session resources (subscriptions, fixtures, fake players, artifacts) on `session.close`/socket close.

### 12.4 Minimal method support matrix (by `agent.kind`)

| Method | headlessBot | clientMod | serverPlugin/Mod | pixelOcr |
|---|---|---|---|---|
| `session.create`/`session.close`/`session.ping`/`session.describe` | ✅ | ✅ | ✅ | ✅ |
| `world.join`/`world.leave` | ✅ | ✅ | ✅ (no-op join) | ➖ |
| `world.runCommand`/`world.sendChat` | ✅ | ✅ | ✅ (as console/player) | ➖ |
| `screen.pressKey`/`screen.screenshot` | ➖ | ✅ | ➖ | ✅ |
| `screen.clickElement`/`screen.listElements`/`screen.get` | ✅ (container) | ✅ (container+clientScreen) | ➖ | ✅ (OCR) |
| `getWindow` | ✅ | ✅ | ➖ | ➖ |
| `screen.typeText`/`useItem`/`move` | ✅ | ✅ | ➖ | ✅ (screen.typeText/click) |
| `truth.getWorldBlock`/`truth.getEntities`/`getPlayerState`/`getLogs` | via server session | ✅ (client log) | ✅ | ➖ |
| `fixture.reset`/`fixture.set`/`player.spawnFake`/`truth.assertPluginState` | ➖ | ➖ | ✅ | ➖ |
| `subscribe`/`unsubscribe` (chat/log/screen) | chat(+screen) | chat/log/screen | chat/log | ➖ |

(✅ supported, ➖ not advertised — negotiation will deny the corresponding capability.)

---

## 13. Quick reference — method and event index

**Methods (requests) — canonical catalog:**
`session.create`, `session.describe`, `session.close`, `session.ping`, `world.join`, `world.leave`, `world.sendChat`, `world.runCommand`, `world.waitForChat`, `screen.get`, `screen.listElements`, `screen.clickElement`, `screen.typeText`, `screen.pressKey`, `screen.screenshot`, `screen.waitForScreen`, `screen.close`, `truth.getWorldBlock`, `truth.getEntities`, `truth.assertPluginState`, `fixture.set`, `fixture.reset`, `player.spawnFake`, `player.despawnFake`.

*(Non-canon agent extensions documented above but outside the canonical catalog: `useItem`, `move`, `getWindow`, `getPlayerState`, `getLogs`, `subscribe`, `unsubscribe`.)*

**Events (notifications):** `event.chat`, `event.screenChanged`, `event.log`, `event.disconnected`.

**Streams (extension `subscribe` `stream` values):** `chat`, `log`, `screenChanged`.

**Capability keys (flat, canonical):** `chat`, `command`, `containerGui`, `clientScreens`, `screenshot`, `rendering`, `worldTruth`, `pluginState`, `fixtures`, `fakePlayers`, `typeText`, `pressKey`, `testIdTags`. Target descriptors: `loader` (enum), `mcVersionRange` (string).

**Selector keys (shape only; grammar in `SELECTORS.md`):** `label`, `text`, `textContains`, `loreContains`, `itemType`, `role`, `index`, `nth`, `within`, `testId`. Role enum: `button` | `slot` | `label` | `input` | `tab` | `list` | `listItem`.

**Error codes (MCTP-specific):** `-32000 ELEMENT_NOT_FOUND`, `-32001 AMBIGUOUS_SELECTOR`, `-32002 METHOD_NOT_SUPPORTED`, `-32003 TIMEOUT`, `-32004 WORLD_NOT_READY`, `-32005 FIXTURE_FAILED`, `-32006 ASSERT_FAILED`, `-32099 PROTOCOL_VERSION_UNSUPPORTED`. **Standard JSON-RPC:** `-32700 parseError`, `-32600 invalidRequest`, `-32601 methodNotFound`, `-32602 invalidParams`, `-32603 internalError`. **Runner-level skip reason:** `NO_COMPATIBLE_DRIVER` (carries `unmet[]`).
