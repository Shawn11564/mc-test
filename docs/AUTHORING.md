# Authoring tests

How to write `.mctest.yml` step files (and the equivalent fluent API). This is the
*user* reference; the canonical wire spellings live in [`PROTOCOL.md`](./PROTOCOL.md)
(methods/errors), [`SELECTORS.md`](./SELECTORS.md) (selectors), and
[`CAPABILITIES.md`](./CAPABILITIES.md) (capabilities) — this doc defers to them.

> **Editor autocomplete:** register the JSON Schema
> `packages/protocol/schema/mctest-stepfile.schema.json` for `*.mctest.yml` — add a
> `# yaml-language-server: $schema=<path-or-url>` modeline at the top of the file (works in
> VS Code and IntelliJ), or map it in IntelliJ → Settings → JSON Schema Mappings.

## Shape of a step file

```yaml
# yaml-language-server: $schema=https://mc-test.dev/schema/mctest-stepfile.schema.json
name: regions-open-testregion       # optional (defaults to the file name)
requires:                           # capabilities the run MUST have, else the test SKIPS
  command: true
  containerGui: true
steps:                              # ordered; each step is a single { verb: args } map
  - join: { username: Tester }
  - command: "or"                   # runs /or
  - waitForScreen: { titleContains: "OpenRegions" }
  - click: { label: "Regions" }
  - click: { label: "TestRegion" }
  - assertChat: { contains: "Region loaded" }
  - assertPluginState:
      requires: { pluginState: true }   # per-step gate → SKIPS just this step if unavailable
      plugin: "OpenRegions"
      query: "regions.exists"
      args: { name: "TestRegion" }
      expect: true
```

The **same** test in the fluent API (TypeScript) compiles to the identical step list:

```ts
import { test } from "@mc-test/runner";
test("regions-open-testregion")
  .requires({ command: true, containerGui: true })
  .join({ username: "Tester" })
  .command("or")
  .waitForScreen({ titleContains: "OpenRegions" })
  .click({ label: "Regions" })
  .click({ label: "TestRegion" })
  .assertChat({ contains: "Region loaded" })
  .assertPluginState({ requires: { pluginState: true }, plugin: "OpenRegions",
                       query: "regions.exists", args: { name: "TestRegion" }, expect: true });
```

## Step verbs

| Verb | Args | Needs capability | Notes |
|------|------|------------------|-------|
| `join` | `{ username?, host?, port? }` | — | host/port are injected from the provisioned server; just set `username`. |
| `leave` | — | — | |
| `chat` | `"msg"` or `{ message }` | `chat` | |
| `command` | `"cmd"` (no leading `/`) | `command` | e.g. `command: "or"` runs `/or`. |
| `waitForChat` / `assertChat` | `{ contains?, regex?, timeoutMs? }` | `chat` | runner-side wait over the chat stream. |
| `waitForScreen` | `{ titleContains?, screenId?, kind?, timeoutMs? }` | `containerGui` **or** `clientScreens` | |
| `listElements` | `{ selector? }` | `containerGui` **or** `clientScreens` | |
| `click` | a **selector** (see below) | `containerGui` **or** `clientScreens` | wrapped in SelectorWaits (auto-retries `ELEMENT_NOT_FOUND`). |
| `type` | `{ text, selector?, clear?, submit? }` | `typeText` | |
| `press` | `{ key }` | `pressKey` | semantic key name (`ENTER`, `ESCAPE`). |
| `screenshot` | `{}` | `screenshot` | rendered-client drivers only. |
| `getBlock` | `{ world?, x, y, z, expect? }` | `worldTruth` | server agent. With `expect` (a block id, e.g. `minecraft:bedrock`) the step ASSERTS the read and fails on mismatch (case-insensitive); without it, it's a bare read that still exercises the path. |
| `getEntities` | `{ world?, near?, type?, radius? }` | `worldTruth` | server agent. |
| `assertPluginState` | `{ plugin, query, args?, expect }` | `pluginState` | `expect` is REQUIRED; a bare value is `equals` (e.g. `expect: true`), or use `{ gt, gte, lt, lte, contains, equals, notEquals, exists }`. |
| `fixture` | `{ name, args }` or `{ reset: true }` | `fixtures` | deterministic setup; `reset` reverts session fixtures. |
| `spawnFakePlayer` | `{ name, at? }` | `fakePlayers` | server agent + Carpet backend (skips on plain Paper). |

## Selectors (semantic, never coordinates)

A `click`/`listElements` selector ANDs all present keys. **Never** use a slot index or pixel.

| Key | Matches |
|-----|---------|
| `label` (or `text`) | exact visible display name (`{ label: "Regions" }`) |
| `textContains` | substring of visible text |
| `loreContains` | substring of an item's lore/tooltip |
| `itemType` | item id (`minecraft:paper`) |
| `role` | `button` \| `slot` \| `label` \| `input` \| `tab` \| `list` \| `listItem` |
| `index` / `nth` | the nth match (0-based / 1-based) when several match |
| `within` | scope to a sub-selector's match |
| `testId` | an invisible tag a cooperating SUT stamps (most robust). Shorthand: `click: "#myTag"`. |

Shorthand: `click: "Regions"` ≡ `click: { label: "Regions" }`; `click: "#save"` ≡
`click: { testId: "save" }`.

## Capabilities & honest skips

A test (or step) declares `requires:`; the runner runs it only if the selected driver — plus
any co-selected agents — advertises every key. Otherwise it **skips with a reason** (never a
false pass). Keys: `chat`, `command`, `containerGui`, `clientScreens`, `screenshot`,
`rendering`, `worldTruth`, `pluginState`, `fixtures`, `fakePlayers`, `typeText`, `pressKey`,
`testIdTags`. The headless bot advertises `chat/command/containerGui/typeText/pressKey`;
`server-bukkit` adds `worldTruth/pluginState/fixtures/chat/testIdTags` (and `fakePlayers` only
with a Carpet backend). Put GUI assertions behind `containerGui`, server-truth behind
`pluginState`, etc., and the same file runs-or-honestly-skips across the matrix.

## Pitfalls

- **`assertPluginState` needs `expect`** — without it the step errors (a missing verdict would
  be a false green).
- **`assertChat` is a substring/regex match** on the chat stream; it does not prove server
  state. Pair it with `assertPluginState` to assert *real* state (the regions test does both).
- **Old versions honestly skip** (`UNSUPPORTED_TARGET` / `VIA_BRIDGE_UNAVAILABLE`) in v1.0 —
  see [`ENVIRONMENTS.md`](./ENVIRONMENTS.md).
- Author **semantic** selectors; if a label is dynamic, have your SUT stamp a `testId`.
