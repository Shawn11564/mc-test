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
| `useBlock` | `{ pos: {x,y,z}, face, hand?, sneak?, cursor? }` | `worldInteraction` | act on the world AS the player (`sneak: true` suppresses the block's own use behavior, so a held item places against the clicked face). |
| `attackBlock` | `{ pos, face, breakBlock? }` | `worldInteraction` | |
| `setHeldItem` | `"minecraft:oak_sign"` or `{ item?, slot?, hand? }` | `worldInteraction` | |
| `look` | `{ yaw?, pitch?, at?, force? }` | `worldInteraction` | |
| `move` | `{ controls?, durationMs?, stop? }` | `worldInteraction` | |
| `getBlock` | `{ world?, x, y, z, expect?, expectProperties?, expectNbt? }` | `worldTruth` | server agent. With `expect` (a block id, e.g. `minecraft:bedrock`) the step ASSERTS the read and fails on mismatch — case-insensitive, the `minecraft:` namespace optional, and `*`/`?` globs allowed (`*_sign`). `expectProperties` subset-matches the blockstate (`{ facing: east }`), `expectNbt` the block entity. Without any, it's a bare read that still exercises the path. |
| `waitForBlock` | `getBlock` args + `{ timeoutMs?, intervalMs? }` | `worldTruth` | the same probe, retried until it holds (deferred state); needs at least one expectation. |
| `getContainer` | `{ world?, x, y, z, expect?, expectCount?, expectSlots? }` | `worldTruth` | |
| `getItem` | `{ world?, x, y, z, slot, expect? }` | `worldTruth` | component-exact item identity. |
| `getEntities` | `{ world?, near?, type?, radius? }` | `worldTruth` | server agent. |
| `assertPluginState` | `{ plugin, query, args?, expect }` | `pluginState` | `expect` is REQUIRED; a bare value is `equals` (e.g. `expect: true`), or use `{ gt, gte, lt, lte, contains, equals, notEquals, exists }`. |
| `waitForPluginState` | the same + `{ timeoutMs?, intervalMs? }` | `pluginState` | assert-until twin of the above. |
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

## Matrices and invariants (`matrix:` + `expect:`)

Everything above writes **one** test. A `matrix:` block turns it into a family of **cases** — one
per full combination — and an `expect:` block gives them **one shared oracle** whose expected
values are functions of the case's config. That pairing is the point: 36 copy-pasted tests can
each be quietly softened until they pass; one invariant cannot.

The canonical live example is [`examples/regions/regions.matrix.mctest.yml`](../examples/regions/regions.matrix.mctest.yml).

```yaml
matrix:                     # each key is a DIMENSION; a case is one value from each
  face:
    values: [north, south, east, west, up, down]
    bind: { step: useBlock, param: face }      # set `face:` on every useBlock step
  held:
    values: { empty: null, sign-item: minecraft:oak_sign }   # label: value
    bind: { setup: give-and-hold }             # named fixture action, run before the steps
  neighbor:
    values: { free: null, occupied: minecraft:stone }
coverage: full              # or `pairwise` — a covering subset of the same declared universe
anchors:
  chest: { x: 0, y: 64, z: 0 }                 # named positions the expectations refer to
steps:
  - setHeldItem: { item: "$held" }             # $dim resolves to the case's value
  - useBlock: { pos: { x: 0, y: 64, z: 0 }, sneak: true }
expect:
  - when: { neighbor: free }                   # this branch judges only the matching cases
    because: a sneak-click places the sign on the face we clicked
    block: { pos: "chest + $face", is: "*_sign", properties: { facing: "$face" } }
  - when: { neighbor: occupied }
    block: { pos: "chest + $face", is: minecraft:stone }
    chat:  { contains: "face is blocked" }
```

**Dimensions and `bind:`** — `values` is a list, or a mapping of *label → value* when the value is
not readable on its own (`empty: null`). The label is what appears in the case id, in
`results.json`, and in `when:`. `bind:` says how the value reaches the run:

| `bind:` | Effect |
|---------|--------|
| `{ step: <verb>, param: <name> }` | sets that parameter on every step with that verb |
| `{ setup: <action> }` | runs `fixture: { name: <action>, args: { <dim>: <value> } }` before the steps |
| `{ environment: <key> }` | selects a provisioning variant; all cases sharing a variant share **one server boot** |

Unbound dimensions still reach the steps and the expectations through `$dim` substitution. Every
case is preceded by a `fixture: { reset: true }` so cases cannot leak into each other (it honestly
skips where no fixture provider is connected).

**`coverage:`** — `full` (default) runs the whole cross-product; `pairwise` runs a covering subset
in which every *pair* of values appears at least once. `results.json` always reports the **full
declared universe** in `declared` and only the cases that actually ran in `executed`, so a pairwise
run — or a run with skips — can never claim 100% completeness.

**`expect:` — the invariant.** An ordered list of branches. A branch's `when:` maps dimension →
value (or list of values, meaning any-of) and matches either the symbolic label or the concrete
value; a branch with no `when:` judges every case. **All** matching branches apply (ANDed).
Expected values are substituted per case, so one branch expresses "the sign lands on whichever
face we clicked" rather than six near-copies. Clause kinds:

| Clause | Args | Needs | Runs as |
|--------|------|-------|---------|
| `block` | `{ pos, is? \| absent?, properties?, nbt?, world?, timeoutMs?, intervalMs? }` | `worldTruth` | `getBlock`, or `waitForBlock` when `timeoutMs` is given |
| `chat` | `{ contains? \| matches? \| regex?, timeoutMs? }` | `chat` | `assertChat` (`matches` is an alias of `contains`) |
| `pluginState` | `{ plugin?, query, args?, is, timeoutMs? }` | `pluginState` | `assertPluginState`, or `waitForPluginState` with `timeoutMs` |
| `container` | `{ pos, is?, count?, slots?, world? }` | `worldTruth` | `getContainer` |

Each clause may also be a **list** of clauses. `pos:` accepts `{x,y,z}`, `"x,y,z"`, an `anchors:`
name, or arithmetic — `"chest + $face"`, `"chest - up"`, `"0,64,0 + 1,0,0"` (operators must be
surrounded by spaces; offsets are face names or `dx,dy,dz`).

**`except:` — per-case overrides, always flagged.** Allowed, because reality sometimes demands it,
but never quiet: each entry needs a written `reason:`, it **replaces** the shared oracle for the
cases it names, and every affected case carries an `exception` field in `results.json` plus a loud
note in the report.

```yaml
except:
  - case: "face=down,neighbor=free"     # exact case id, or `when: { … }`
    reason: "MC-12345 — signs cannot attach to the underside; tracked upstream, not accepted"
    expect:
      - block: { pos: "chest + $face", absent: true }
```

**Static lints (run before anything boots).** Two ways a matrix can look like coverage and prove
nothing; both are reported on the console and carried in `results.json` under `lints`:

- **`vacuous-branch`** — an `expect:`/`except:` entry whose `when:` selects **0** generated cases
  (a typo'd dimension, a value that no longer exists, or cases a `pairwise` subset dropped). A
  branch nothing selects can never fail, so it judges nothing.
- **`dead-dimension`** — a dimension no expectation depends on: not named in any `when:`, not used
  as `$dim` in any expectation or authored assertion step. The run varies the input N ways and
  asserts the same thing every time, so the extra cases are theater. `environment`-bound
  dimensions are exempt (proving the *same* invariant across boots is the point).

**Verdicts** are `pass` (every expectation held) · `fail` (the steps ran, an expectation broke) ·
`error` (a step itself broke) · `skip`. An invariant the selected driver cannot evaluate — no
`worldTruth`, no connected agent — makes the case a **skip** (`INVARIANT_NOT_EVALUATED`), never a
pass: an oracle that never read the world has not judged anything.

**Watching a run live:** `--events <stdout|stderr|path>` emits the run as NDJSON
(`run-start`/`case-start`/`step-*`/`case-end`/`run-end`) for a live consumer — see
[`EVENTS.md`](./EVENTS.md).

## Validating an invariant: the lab controls

A green invariant proves nothing on its own — it might be too loose to fail, or aimed at the wrong
thing. `mc-test validate` runs **today's check against another commit's code**, which is what turns
an assertion into an oracle (spec §5):

```bash
# POSITIVE control — a known-good build must be green, or the invariant is too strict:
mc-test validate tests/mctest/placement.matrix.yml --against-commit HEAD \
        --build "./gradlew build -x test" --artifact build/libs/sut.jar --target paper-1.21.1

# NEGATIVE control — a known-bad commit must go red, on exactly the bad combinations:
mc-test validate tests/mctest/placement.matrix.yml --against-commit <mutant sha> --expect-fail \
        --expect-cases "held=block,neighbor=occupied" ...
```

It checks the sha out in a git worktree, builds **that** commit there, and runs the check from your
**working tree** against it — running the old commit's own tests against itself would prove nothing.
The worktree is removed afterwards (`--keep` retains it).

| Flag | Meaning |
|------|---------|
| `--against-commit <rev>` | the commit to judge (sha, tag, branch) |
| `--expect-fail` | negative control: the run MUST go red. Without it, the run must be GREEN |
| `--expect-cases "d=v,d=v"` | ...red on exactly the cases whose config matches, and no others |
| `--repo <path>` | repo holding the commit (default: cwd) |
| `--build "<cmd>"` | build command (default: detected — `gradlew build -x test` / `mvn package`) |
| `--artifact <jar>` | built SUT, relative to the worktree (default: detected in `build/libs`/`target`) |

Exit codes: **0** the control behaved as claimed · **1** it did not · **2** the control could not be
set up (unknown commit, no build, no jar). A control that *demonstrates* nothing fails: a run where
nothing executed, or a positive control with skipped cases, is `INCONCLUSIVE`, not green.

Keep every mutant you write — a bug that reached a test becomes a permanent negative control. See
[`tests/MUTANTS.md`](../tests/MUTANTS.md) for the convention (a labeled branch, one commit, the
expected-red cases recorded) and for this repo's worked example.

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
  state. Pair it with `assertPluginState` to assert *real* state (the regions test does both) —
  a SUT can announce "Region loaded: Market" while activating something else entirely.
- **A matrix without an `expect:` is usually theater.** If every case asserts the same hard-coded
  thing, the dimensions changed the inputs and nothing changed the judgement; the `dead-dimension`
  lint says so. Write the oracle as a function of the config instead.
- **Old versions honestly skip** (`UNSUPPORTED_TARGET` / `VIA_BRIDGE_UNAVAILABLE`) in v1.0 —
  see [`ENVIRONMENTS.md`](./ENVIRONMENTS.md).
- Author **semantic** selectors; if a label is dynamic, have your SUT stamp a `testId`.
