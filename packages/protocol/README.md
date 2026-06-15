# @mc-test/protocol

The **MC Test Protocol (MCTP)** contract — the single, stable wire format that
decouples the mc-test runner (TypeScript) from every in-game driver/agent
(TypeScript or Java). This package is the **narrow waist** of the whole system,
in executable form.

It is **pure data + functions**: TypeScript types, JSON Schema, a capability
matcher, a selector describer, the error model, and golden conformance fixtures.
It has **no dependency on any game, Mineflayer, or the JVM** (its only runtime
dependency is [TypeBox](https://github.com/sinclairzx81/typebox)).

> `docs/PROTOCOL.md` is the authoritative prose spec for the wire vocabulary.
> This package is its machine-checked form: every method, event, capability key,
> selector key, and error code here matches `docs/PROTOCOL.md` exactly.

## What's in the contract

- **Transport** (frozen): JSON-RPC 2.0 over a single WebSocket. The runner is the
  client; each driver/agent is the server. `session.create` negotiates a
  `protocolVersion` starting at `"1.0"`.
- **24 methods** across `session.*`, `world.*`, `screen.*`, `truth.*`,
  `fixture.*`, `player.*`, plus **4 events** (`event.chat`, `event.screenChanged`,
  `event.log`, `event.disconnected`). Each method ships a params type, a result
  type, and a JSON Schema pair.
- **Capability vocabulary** (`CapabilityKey`, `Loader`) + the pure
  `matchCapabilities(required, advertised) → { ok, unmet[] }` used for
  driver selection and honest skips.
- **Semantic selectors** (`Selector`, roles) + `describeSelector()` for stable
  skip/error/report strings.
- **Error model**: the canonical codes/reasons (`ELEMENT_NOT_FOUND`,
  `AMBIGUOUS_SELECTOR`, `METHOD_NOT_SUPPORTED`, `TIMEOUT`, `WORLD_NOT_READY`,
  `FIXTURE_FAILED`, `ASSERT_FAILED`, `PROTOCOL_VERSION_UNSUPPORTED`, the standard
  JSON-RPC range) + the runner-level skip reason `NO_COMPATIBLE_DRIVER`.
- **Authoring model**: `Test` → `Step[]` → `Target` (the write-once layer).

## How types and schema stay in sync

Both the TypeScript types and the published JSON Schema are derived from the
**same TypeBox objects**, so they cannot drift by construction. The committed
files under [`schema/`](./schema) are generated from those objects; a CI gate
([`test/schema-sync.test.ts`](./test/schema-sync.test.ts)) regenerates them and
fails on any byte difference. Run `npm run gen:schema` after changing a type.

## Conformance fixtures

[`fixtures/conformance/`](./fixtures/conformance) holds golden request/response
JSON for **every** method and event, plus error and negative-control cases. They
validate against the JSON Schema in CI
([`test/validate-fixtures.test.ts`](./test/validate-fixtures.test.ts)) and are
the executable contract every future driver/agent must satisfy: a driver isn't
"done" until it is green against these.

## Usage

```ts
import {
  matchCapabilities,
  describeSelector,
  METHOD_SCHEMAS,
  PROTOCOL_VERSION,
  type Selector,
  type SessionCreateParams,
} from "@mc-test/protocol";

matchCapabilities({ command: true, clientScreens: true }, { command: true, containerGui: true });
// → { ok: false, unmet: ["clientScreens"] }

describeSelector({ label: "Regions", within: { role: "tab" } });
// → 'label="Regions" within(role=tab)'

// The runtime TypeBox schema for any method's params/result:
METHOD_SCHEMAS["screen.clickElement"].params; // a JSON Schema object
```

The JSON Schema files are also published and can be imported directly, e.g.
`@mc-test/protocol/schema/methods/screen.clickElement.request.schema.json`.

## Layout

```
src/
  constants.ts     transport/handshake constants (protocol version, sub-protocol, path)
  common.ts        shared schema fragments + builders
  selectors.ts     Selector + roles + describeSelector
  capabilities.ts  capability keys, Capabilities, matchCapabilities, version-range helpers
  mctp.ts          envelopes, error model, element/screen/entity shapes, every params/result
  methods.ts       MethodName/EventName, MctpMethods map, METHOD_SCHEMAS registry, envelope builders
  authoring.ts     Test / Step / Target authoring model
  index.ts         public barrel
schema/            generated JSON Schema (top-level + methods/ + events/)
fixtures/conformance/  golden request/response/error/negative fixtures
scripts/gen-schema.mts emits schema/ from the TypeBox contract
```

## Scripts

| Script | What it does |
|--------|--------------|
| `npm run gen:schema` | Emit `schema/` from the TypeBox contract. |
| `npm run typecheck`  | `tsc --noEmit` (strict). |
| `npm run build`      | Regenerate schema, then emit `.d.ts` + JS to `dist/`. |
| `npm test`           | Run the drift gate, fixture validation, and unit tests. |
