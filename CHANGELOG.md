# Changelog

All notable changes to this project are recorded here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims to follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> mc-test is currently **internal/private** (decision **D1**, 2026-06-16): the `@mc-test/*` packages are
> not published to npm and the agent jars are not attached to GitHub Releases. Version tags are internal
> release markers. Revisit publishing for v2.

## [Unreleased]

### 2026-10-16 — the macro menu, and `/macro edit`
- **`/macro` (or `/m` alone) opens a macro menu** on server-neoforge and server-fabric (docs/MACROS.md §8). It's a
  chest menu, so a vanilla client needs nothing. Every macro is a shulker box (one colour per file) whose tooltip
  shows its parameters, description and steps. Click to pick one up and put it down elsewhere (drop it on another to
  swap, carry it onto ▶ for the next page), right-click to open it, shift-click to run it. The arrangement is kept
  in `macros.layout` in the first macro folder. An open macro shows every step as an icon for its kind. Drag them to
  reorder, right-click to edit, shift-click to insert before, Q to delete. Undo, run, run with values, add a step,
  rename or re-parameter, describe, copy and delete (with a confirm screen) are buttons. Text goes through chat as a
  filled-in, clickable command, and the menu opens again when it works. **Edit in a book** puts the whole macro in
  a book and quill; Done saves it.
- **`/macro new|copy|delete|undo` and `/macro edit <name> add|step|insert|remove|move|header|describe|book`**: the
  commands behind the menu, usable on their own. Edits change only that macro's lines (other macros, comments,
  indentation and line endings stay). An edit that would add a parse error is refused, and undo refuses if the file
  changed since. `/macro show` now prints the steps. `/macro help` lists the commands.
- **Game-free core:** `bench/MacroMenu` (screens), `MacroSource` (text edits), `MacroEditor` (files, checks, undo),
  `MacroLayout` (arrangement). The shims are `mappings/MacroMenus` per agent. `MacroLibrary` now rescans its folders
  at most every 500 ms instead of on every lookup (the menu looks up a lot per redraw), and knows each macro's file.
- **Proof:** `agents/core` unit tests (`MacroSourceTest`, `MacroMenuTest`), and **`tests/e2e/run-bench-macro-menu.mjs`**,
  42 checks per loader on a real server with a real client (Mineflayer) sending the clicks a vanilla client sends.
  Both loaders pass. Negative control: on Fabric, with shift-click mapped to nothing, exactly the three run checks
  fail.
- **Fixed a race in `run-bench-control.mjs`** ("kicking the parked player disconnects the client" failed once on
  each loader when run after the other checks). The server sends the reason and closes. A client still sending
  movement can get the close as a TCP reset, and on Windows the reset can drop the unread reason (seen in a run:
  the client got `end socketClosed` while the server logged the reason). The check now takes the reason from the
  server's `lost connection` line and only needs the client to be gone. It also checks that control works again
  after logging back in, and prints triage on failure.

### 2026-10-16 — `/actor <name> view|control` + `/actor back`; `/macro` on Fabric
- **See as an actor, or play as one, then go back** (server-neoforge and server-fabric, `mappings/ActorControl`):
  `/actor <name> view` makes you a spectator with your camera on the actor. `/actor <name> control` hands your
  connection to the actor's player the way vanilla's respawn hands one to a new player, so your keys, mouse,
  inventory, menus, chat and commands are the actor's, with its permissions. Your own player is parked out of the
  world, still online. `/actor back` (or the clickable **[back]**, which keeps working as a non-op actor) returns you
  where and as you were: position, world, inventory, game mode. Nobody logs in or out. A disconnect mid-control saves
  both players where they were and brings the actor back a tick later. A kick of your parked player disconnects your
  client. A server stop hands everyone back first. While controlled, the actor refuses `/actor` verbs and `player.act`
  ("being controlled by …").
- **`/macro` and `/m` on server-fabric**, the same engine and commands as NeoForge. Fabric gains the hooks they need:
  the actor-command observer, a told-listener on the discard connection (chat, action bar, titles), and a
  `CommandManager.execute` mixin for recording (Fabric API has no command event). Fabric's agent now has an access
  widener and a mixin config.
- **Fabric fixes found on the way:** the discard connection now runs send callbacks, which a disconnect needs to close
  the channel, so `/kick` and shutdown take an actor through the real leave path. Despawn and `player.act` refuse a
  player who isn't behind a discard connection, as NeoForge already did.
- **Proof, real servers + a real client (Mineflayer), both loaders:** `tests/e2e/run-bench-control.mjs` (34 checks per
  loader: hand-over to the actor's position/inventory/game mode, walking moves the actor, chat and commands are the
  actor's, back as a non-op, view, the real-player guard, disconnect and kick mid-control) and
  `tests/e2e/run-bench-macros.mjs` (19 checks per loader). Negative controls: dropping the actor-command observer
  turns "a refused actor command stops the macro" red; skipping the game-mode relabel turns the own-tab-entry check
  red. `run-bench-actors.mjs` still passes on both. Not checked: a rendered vanilla client (Docker wasn't running).

### 2026-10-16 — `/macro`: saved command groups for manual play testing (docs/MACROS.md)
- **New in-game `/macro` and `/m`** on server-neoforge (op 2), next to `/actor`: run a project's named,
  parameterized command groups from `.macro` files in the folders `MCTEST_MACROS` names (re-read when they change).
  `/m expedition.take Carol n=2`, `/macro again Dave`, `list`, `show`, `stop`, `continue`, `reload`,
  `record start|save|cancel`, `last <n> as <name>`. Steps: commands (`-/` carries on after a failure, `+/` shares the
  previous command's tick), `wait`, `waitfor`/`expect <who> [not] told "<text>"` with `{=name}` captures, `run`,
  `say`, `pause`. A command fails when it doesn't run, throws, or returns 0 after a red message, and an
  `/actor X cmd` step fails when the actor's command does: a refused setup step stops the macro instead of testing
  the wrong state. Recording turns actor names into parameters.
- **Game-free engine in `agents/core`** (`io.mctest.agent.core.bench`: parser, arguments, runner, told-log,
  recorder): 27 unit tests. **`GuideCheck`** checks a markdown test guide: every `/m` call resolves and fits, and no
  step points back ("the same way", "as in 3.3", "(step 2)") instead of saying what to do.
- **A bench convenience, not a test path:** no MCTP change; the runner doesn't use it. Fabric, Forge and Bukkit
  shims are still to do.
- **`/actor <name> cmd`** now reports to an observer whether the actor's command worked (`Names.setActorCommandObserver`),
  and every message an actor is told reaches a listener (`setToldListener`); `player.act` is unchanged.
- **Proof:** MapFactions' `checkPlaytest` runs its playtest macros through actors on a real NeoForge 1.21.1 server
  with five integration mods: a menu path, the empty-hand guard stopping a run, a refused actor command stopping a
  run, and a listing number captured from chat and used to buy a deed (`Playtest check PASSED`).

### 2026-10-15 — Tab completion for `/actor`
- **`/actor` completes actor names** (after `/actor` and `/actor remove`; real players are never
  offered), online players for `attack`/`use`, and — the useful one — **the command after `cmd`**,
  completed as the actor would see it: the server's dispatcher (Brigadier on fabric/forge/neoforge,
  the command map on bukkit) is asked as the actor's own command source, so a non-op actor isn't
  offered `gamemode`. Brigadier doesn't check `requires` when it lists the next words (vanilla relies
  on the client only holding usable commands), so the Brigadier agents filter by `canUse` themselves.
  The bukkit agent's `/actor` now also completes its subcommands, verbs and `on|off`.
- **Proof**: `tests/e2e/run-bench-actors.mjs` step 3a joins a real client (Mineflayer) to each lane
  and asks for completions over the protocol, including the non-op and non-actor negatives. Green on
  fabric 1.21.1, neoforge 1.21.1, forge 1.20.1 and paper-native 1.21.1.

### 2026-08-18 — Click a GUI by the text it shows (spec/42 click-text)
- **New `player.act` verb `clickMenuText`** `{ text, exact?, lore?, index?, button?, mode? }` on all
  four server agents: clicks the slot of the actor's open menu whose **display name — or lore —**
  says `text`. Clicking a modded GUI by slot index requires already knowing its layout, which for a
  PokeSteal steal menu or a Cobblemon screen means counting squares in a screenshot; this is the
  addressing a human actually has. Matching runs through the project's one normalization pipeline
  (`SelectorMatch.normalize`, SELECTORS.md §4.1), name hits ranked ahead of lore hits. No match →
  `-32000 ELEMENT_NOT_FOUND` **naming what the menu does say**; more than one match without an
  explicit `index` → `-32001 AMBIGUOUS_SELECTOR` listing the matching slots (a guess is worse than a
  question when the click is a real action).
- **New MCTP method `player.menu`** (cap `fakePlayers`, detail `menu:true`): the open menu's slots —
  index, item id, count, display name, lore, and whether the slot is the actor's own inventory. The
  read half of the same feature: a controller can show a GUI's real contents instead of guessing.
- **`clickMenuSlot` gained `button` + `mode`** (the vanilla click protocol's own two parameters), so
  right-clicks and shift-clicks on a menu are expressible; `mode: "right"` is accepted as the button
  it plainly means. Click types are mapped by an explicit switch per loader — enum constant names are
  remapped at runtime, so `valueOf` on a mapping-neutral string would work in dev and fail on a real
  server.
- **`/actor` gained `menu`, `click`, `rclick`, `shiftclick`** on all four agents (and `slot <n> [mode]`),
  delegating to the same one implementation `player.act` uses — one behaviour, two front doors.
- Shared, testable core: `Menus` + `MenuView` in `agents/core` (10 unit tests) — matching, click-mode
  aliases, the error factories, and the JSON shaping every agent returns.
- **Live-verified on all four loaders** (`tests/e2e/run-bench-actors.mjs`, 30/30 per lane against a
  real dedicated server): the actor places a chest, fills two slots, opens it, `player.menu` reads it
  back, a miss returns `ELEMENT_NOT_FOUND`, a tie returns `AMBIGUOUS_SELECTOR`, and `index:1` clicks
  exactly the second match. That run caught a real bug on Paper — `InventoryView.countSlots()` counts
  the armour and offhand slots a container menu does not expose, so reading to it overran the view.

### 2026-08-17 — Bench actors: persistent fake players + /actor + handshake token (spec/42)
- **`player.spawnFake` gains `persist:true`** (commandcenter spec/42): the fake joins an
  **agent-global registry**, survives `session.close`/socket drop, is addressable by `name` from
  any session, and dies only on `player.despawnFake`, `/actor remove`, or server stop. Default
  (`false`) keeps today's session-scoped lifetime — the runner is untouched. The ownership
  registry stays the puppetability boundary: real players can never be driven.
- **New MCTP method `player.list`** (cap `fakePlayers`, detail `list:true`): the full agent-owned
  roster — name/uuid/persist/spawnedBy plus live position/dimension/gameMode/health — so a fresh
  controller (CC's Actors panel) re-acquires persistent actors after a reconnect. Schemas,
  conformance fixture, and core stubs included; `fakePlayers` detail now also advertises
  `persist`/`list`.
- **New in-game `/actor` command on `server-fabric`** (op level 2, Brigadier): spawn/remove/list
  plus the whole portable verb set (`here`, `look`, `chat`, `cmd`, `attack`, `use`, `useblock`,
  `slot`, `give`, `hold`, `sneak`, `sprint`, `gamemode`) — the manual front door onto the SAME
  primitives `player.act` drives. Command spawns are persistent by nature.
- **Handshake token implemented** (the one ENVIRONMENTS.md promised): `Dispatch.setAuthToken` +
  `session.create` `params.auth.token`, checked before anything else, `-32602` on mismatch with
  no session created. Agents read `MCTEST_AGENT_TOKEN` (env); the Bukkit agent also honors
  `token:` in `config.yml`. Unset = open (existing runner flows unchanged).
- **`fakePlayers` native on `server-neoforge` (1.21.1 Mojmap) and `server-forge` (1.20.1 Mojmap)**
  — the "no Carpet backend" rationale was stale; both got the full port (Names.java fake-player
  block, FakePlayerManager, `/actor` via `RegisterCommandsEvent`, persist/list, token). NeoForge
  gained a `MappingContractTest` twin; on Forge the ForgeGradle compile against remapped 1.20.1 is
  the drift guard. Runner capability mirrors updated (`fakePlayers: true` on both).
- **`fakePlayers` native on `server-bukkit` — probe-gated reflection** (spec/42 Plan C): the same
  join pattern via reflection against Paper's Mojang-mapped RUNTIME (1.20.5+), quarantined in
  `players/NativeFakePlayers.java`; the enable-time probe resolves every symbol or logs the miss
  and falls back to Carpet-or-skip (Spigot / pre-1.20.5 keep their honest skip). Interaction verbs
  keep Bukkit-event fidelity (`useItemOn`/`clicked` fire the events via CraftBukkit's own patches;
  `PlayerInteractEntityEvent` fired manually first, event-then-vanilla). `/actor` ships as a
  plugin.yml command (`mctest.actor`, default op). The module stays compile-time Bukkit-API-only.
- **Per-version agent jars** (spec/42 Plan D): the modded server agents' gradle pins are now
  `-P`-overridable (`-PmcVersion=…` etc.) and the artifact is `agent-server-<loader>-<mc>.jar`
  (ENVIRONMENTS.md's documented naming, finally true). The runner resolves variants next to the
  legacy path — exact `-<mc>.jar` for the target's MC wins; a version-mismatched variant is never
  silently substituted (warn-and-drop → honest skip).
- **New real-boot E2E `tests/e2e/run-bench-actors.mjs`**: boots each loader's dedicated server
  (Paper included, proving the reflective probe live) and asserts over raw MCTP what a step file
  cannot: token refusal, persist-vs-session lifetime across a DROPPED socket, cross-session
  `player.act` by name, the un-puppetable guard, and roster teardown.

### 2026-08-17 — Native fake players on server-fabric (spec/41 tier 2)
- **`fakePlayers` is native on `server-fabric`** — a real `ServerPlayerEntity` joined through
  `PlayerManager.onPlayerConnect` behind a discard `ClientConnection` (EmbeddedChannel-activated),
  so every join/leave hook fires and **no Carpet mod is required**. Advertised as
  `backend:"native"` with a `verbs` array. Identity is the deterministic offline UUID (stable
  across sessions and tiers, per commandcenter spec/41 §3).
- **New MCTP method `player.act`** (cap `fakePlayers`, native backend only): drives one portable
  actor verb — teleport, lookAt, chat, command, attack, interactEntity, interactBlock,
  clickMenuSlot, give, hold, sneak, sprint, setGameMode — on a fake **this session spawned** (the
  handle registry keeps real players un-puppetable). Interaction verbs fire the Fabric callback
  first, then the vanilla method, mirroring the real packet-handler sequence. Conformance fixture
  `player.act.json` + ConformanceTest coverage; a new server-fabric `MappingContractTest` guards
  the Yarn symbols the join/act path depends on.
- **`player.act` is now in the TypeScript contract** (`METHOD_NAMES` / `MctpMethods` /
  `METHOD_SCHEMAS`, with a closed `PlayerActVerb` union), so its request/result JSON Schemas are
  generated and the conformance fixture validates against them (74 schema files, was 72).
- **New step verb `act`** — the authoring face of `player.act`:
  `act: { name: Rival, verb: interactEntity, args: { target: Tester } }`. Gated on `fakePlayers`
  and routed to the server agent like the other player verbs. Without it a step file could spawn an
  actor and then never move it, which is the half of a two-player feature no test could reach.
- **`attack`/`interactEntity` accept an online player's NAME as `target`**, not only an entity
  uuid. Nothing carries a spawn's returned uuid from one step to the next, so the uuid-only form
  left a step-file author hand-computing offline UUIDs to aim at the other player.
- **`spawnFakePlayer` forwards `gameMode`** — the agent has always accepted it; the step verb was
  dropping it.
- **`server-bukkit` remains Carpet-backed** (spawn/despawn only, opt-in, honest skip on plain
  Paper); its native NMS backend is the remaining spec/41 plan-C work. Docs updated across
  PROTOCOL/CAPABILITIES/AUTHORING/ARCHITECTURE (`engine` detail key corrected to the canonical
  `backend`).

### 2026-08-12 — The §5 controls actually reach a MODDED SUT
Both found by running the ChestShop placement matrix (spec 40 §10 Plan D step 4) — the first real
project outside the regions example to drive `validate --against-commit`.
- **`--plugin <jar>` now overrides a modded target's `mods/`, not only a Bukkit target's `plugins/`.**
  It only ever replaced `plugins`, which a modded server never reads — so `validate` would faithfully
  check out a mutant, build it, and then run the check against whatever the target's own `mods:` path
  pointed at (the working tree). A negative control could build the bad commit and report green about
  the good one. On a modded target the override now replaces the LOCAL (`path:`) mod entries and
  leaves `url:`/`modrinth:` ones alone, because those are the dependencies the SUT needs in order to
  load at all — dropping fabric-api would turn "test the mutant" into "watch the loader fail".
- **`detectBuildCommand` names the Gradle wrapper `.\gradlew.bat` / `./gradlew` on both platforms.**
  cmd.exe searches the working directory first *unless* `NoDefaultCurrentDirectoryInExePath` is set —
  which Git Bash sets and node inherits — so a bare `gradlew.bat` came back "is not recognized" and
  the control exited 2 without ever building the commit under test. Pinned by a test.

### 2026-08-11 — The `expect:` invariant: one oracle, resolved per case
- **`expect:` in a step file is now a real invariant** (spec 40 §4–§5), not just matrix expansion.
  A test declares an ordered list of branches; each branch's `when:` selects the cases it judges,
  and its expected values are **functions of the case config** (`pos: "chest + $face"`,
  `properties: { facing: $face }`) resolved through the same `$dimension` substitution the steps
  use. That is the whole point: one oracle, written once, judges all 36 cases — as opposed to 36
  hand-written assertions that can be quietly reshaped to match whatever the code happened to do.
  Clauses compile to ordinary truth steps (`block` → `getBlock`/`waitForBlock`, `chat`,
  `pluginState`, `container`) in a high index band, so they run through the same executor, routing
  and honest skips as everything else — no second assertion path, no assertion logic in an agent.
- **Honesty rules baked into the parse, not left to review.** A branch that asserts nothing, an
  unknown clause key, a `pluginState` with no expected value, an undeclared anchor — all are load-
  time ERRORS rather than expectations that pass vacuously. Keys naming capabilities mc-test does
  not have (`actor:`, multi-actor, phase 5) are refused **by name** instead of being dropped, since a
  silently ignored expectation reads as coverage. And an invariant the selected driver cannot
  evaluate turns the case into a **skip** (`INVARIANT_NOT_EVALUATED`), never a pass.
- **`except:` per-case overrides are allowed and FLAGGED.** They require a written `reason:`, they
  replace the shared oracle only for the cases they name, and every affected case carries an
  `exception` field in results.json plus a loud note in the human report — exceptions are where a
  circular oracle sneaks back in, so they are never invisible.
- **results.json finally carries what it declared.** `expected`, `actual` and `invariant_ref`
  (`<test>#expect[1]` / `<test>#except[0].expect[0]`) are written per case, on passes as well as
  failures — a pass that cannot say what it proved is the same failure mode in miniature. A broken
  expectation is now classified `fail` (the steps ran, the expectation gave way) rather than `error`.
- **`declared` is the real declared universe.** Under `coverage: pairwise` it is the full
  cross-product while `executed` is the subset that ran, and a **skip is declared-but-not-executed**
  — so completeness (`executed/declared`, spec §7) can no longer report a flattering 100% for a run
  that covered a fraction of the matrix. Verified through the CLI: a 2×2×2 pairwise run writes
  `declared: 8, executed: 0, skipped: 4` when the target honest-skips.
- **`getBlock`/`waitForBlock` block-type matching** gained globs and an optional `minecraft:`
  namespace (`is: "*_sign"` matches `minecraft:oak_sign`), shared by both verbs through one matcher
  so an assert-once and an assert-until read can never disagree.
- **Two static lints (spec §5.3), run before anything boots.** `vacuous-branch`: an
  `expect:`/`except:` entry whose `when:` selects zero generated cases — a typo'd dimension, a value
  that no longer exists, or (said precisely) cases a `pairwise` subset dropped. `dead-dimension`: a
  dimension no expectation depends on, so the run varies the input N ways and asserts the same thing
  every time — the values are theater. `environment`-bound dimensions are exempt, since proving the
  SAME invariant across boots is their whole purpose. Both print at expansion time and ride along in
  `results.json` under `lints`, so a vacuous branch can render like a skip in the coverage web
  instead of quietly inflating the completeness bar.
- **The engine finally has a committed consumer**: `examples/regions/regions.matrix.mctest.yml` —
  one dimension (which region the tester opens) and one invariant that is a function of it (chat
  announces `$region` AND `regions.active == $region`). Its negative control is the point: a SUT that
  announces every region but only ever *activates* Spawn goes red on exactly the other two cases,
  which the single-region test next to it cannot see. `docs/AUTHORING.md` documents
  `matrix:`/`bind:`/`coverage:`/`anchors:`/`expect:`/`except:` and the lints, and backfills the
  world-interaction/truth/time verbs that had shipped undocumented.

### 2026-08-12 — The `--events` run stream and `validate --against-commit`
- **`--events <stdout|stderr|path>` emits the run as NDJSON** (spec §6):
  `run-start / case-start / step-start / step-pass / step-fail / case-end / run-end`, one JSON
  object per line, as it happens — what a live coverage view animates instead of waiting for
  `results.json`. The shape was not invented here: Command Center has shipped a complete consumer
  for weeks whose live trellis simply had **no producer**, so the vocabulary is its vocabulary,
  verified by replaying a real log through CC's own parser + reducer (56/56 lines accepted, the run
  reconstructed case-for-case). `docs/EVENTS.md` records the contract.
- **The stream and the report cannot disagree.** `caseId` comes from the same function
  `results.json` uses, step labels are `<index>:<verb>` (unique within a case, and the invariant's
  own steps are numbered from 1000, so the oracle is visible in the stream), and `run-start` carries
  the whole DECLARED universe so a trellis can draw the matrix before the first case runs. Cases
  decided before any session opened — preflight skips, no compatible driver, a provisioning failure
  — are swept into the log rather than left as nodes that never resolve. Emission is
  fire-and-forget: a dead consumer can never change a verdict.
- **`replayEvents()` rebuilds a run from its log**, kept in-repo as the stream's own conformance
  check: the test asserts the replay matches that same run's `results.json` case-for-case,
  step-for-step, including a red case's failed step and the oracle's expected/actual.
- **`mc-test validate --against-commit <sha>` — the §5 lab controls.** Checks the commit out in a
  git worktree, builds it there, and runs the check **from your working tree** against it (the
  other direction — the old commit's own tests — proves nothing). Default is the POSITIVE control
  (a known-good build must be green); `--expect-fail` is the NEGATIVE control, optionally narrowed
  to exactly the bad combinations with `--expect-cases "held=block,neighbor=occupied"`. A control
  that demonstrates nothing FAILS: nothing executed, or a positive control with skips, is
  inconclusive rather than green; setup problems exit 2, kept distinct from a verdict of 1.
- **Both controls proved on real code, not mocks.** Against the mainline the regions matrix check is
  3/3 green (exit 0), and the same run with `--expect-fail` exits 1 — while against the new labeled
  mutant `mutants/regions-active-pinned` (the GUI announces every region but activates a pinned one)
  it goes red on exactly `region=TestRegion` and `region=Market` and stays green on `region=Spawn`.
  That mutant is a permanent negative control, recorded in `tests/MUTANTS.md` — the failure shape a
  chat-only or single-region test cannot see.

### 2026-08-09 — Matrix expansion: the unit of execution is a CASE
*(backfilled 2026-08-11 — this landed without a CHANGELOG entry.)*
- **`matrix:` in a step file expands to cases** (spec 40 §4), where a case is one complete
  configuration — never a "node"; nodes exist only as aggregates in the visualization. Dimensions
  take a `values` list or a `label: value` mapping (so a value like `null` still has a readable
  name), and `bind:` says how the value reaches the run: `{ step, param }` sets a parameter on
  every step with that verb, `{ setup }` runs a named fixture action before the steps, and
  `{ environment }` selects a provisioning variant.
- **Environment-variant dimensions group cases per boot.** Cases sharing a variant run under ONE
  provisioned server and one driver launch (`Runner.runTargetCases`), each still getting its own
  MCTP session and a `fixture: { reset: true }` preamble — case isolation without paying a server
  boot per cell. (That reset is the fixture ledger's revert, not yet §4's world-region snapshot.)
- **`coverage: full | pairwise`**, the pairwise subset chosen by a deterministic greedy cover so
  every value PAIR appears at least once and reruns are reproducible.
- **Honest at the seams:** a group whose cases select different drivers skips with
  `MATRIX_DRIVER_MISMATCH` rather than guessing, and a fixture/setup step failing is classified as
  a case `error` (runner mechanics broke) rather than a `fail` (an expectation broke).
- **What it did NOT have on this date** — and what the 08-11 entry above closes: no `expect:`
  invariant, no lints, and **no committed consumer**, so the engine could expand cases that nothing
  judged. That gap is why `expected`/`actual`/`invariant_ref` sat unwritten in `results.json` for
  two days.

### 2026-08-08 — Time verbs, sign-editor typing, and a rendered-client-on-modded-server row
- **New time verbs `waitForBlock` / `waitForPluginState`.** Real SUTs write state *after* the action
  that triggered it (a scheduled task, a packet round-trip), which left tests choosing between
  asserting immediately and flaking, or sleeping and hoping. These reuse the `click` retry wrapper
  verbatim — the waiting stays in the runner, the agent keeps answering instantaneously — and share
  their assert-once twin's probe, so `getBlock` and `waitForBlock` can never judge the same world
  differently. On timeout the LAST real mismatch is rethrown, so a failure says what never became
  true rather than "timed out"; a wait with no condition is rejected instead of passing on the first
  read; and a malformed `waitForPluginState` (no `expect`) fails immediately rather than burning the
  budget on a question with no verdict.
- **Sign-editor typing (the `charTyped` fallback).** The vanilla sign editor has **no**
  `TextFieldWidget`/`EditBox` — it drives a `SelectionManager` straight from `Screen#charTyped` — so
  after the plan-A false-green fix every sign-typing step was (correctly) `ELEMENT_NOT_FOUND`. The
  client agents now fall back to replaying the characters on the screen itself, with the honesty
  intact: the verdict comes from `charTyped`'s own boolean, so a screen that *ignores* text is still
  `ELEMENT_NOT_FOUND`; the fallback is only tried when no `selector` was given (a selector names one
  element); and the new `screen.typeText` result field **`typedVia`** (`textField` |
  `screenCharTyped`) means a report can never hide which path ran. The policy lives in
  `/agents/core` (unit-tested with a fake bridge); only the mapped `charTyped` call is per loader.
- **New `signEditor` fixture** on the Bukkit agent (`Player#openSign`): the server opens a real sign
  editor on a real client. This is what makes the above testable end to end — the rendered client
  advertises no `worldInteraction` yet, and the vanilla protocol lets the server do it.
- **A rendered-client-on-MODDED-SERVER matrix row** (`fabric-server-1.21-client`). Every earlier
  `driver: inprocess` row boots a Paper server, which is right for a client-side-only mod but left a
  SUT that is one mod on BOTH sides (a shop's shape: server owns the state, client owns the GUI) with
  no row to copy. Fixing it needed a real gap closed: the client's mod list silently **dropped**
  `modrinth:` entries (they have no local `path`), so a client could come up missing a dependency the
  SUT needs to load. New target key **`clientMods`** states the client's set explicitly, and every
  entry is resolved.
- **Fixed a rendered-client process leak** found while proving the above: the launched client JVM
  re-execs, so the pid the driver holds exits while the real client keeps running. Teardown believed
  Node's `exitCode` and skipped every escalation, leaving a client alive that kept the extracted
  GLFW/LWJGL natives mapped — the next rendered run then failed `EBUSY … glfw.dll`, which reads as a
  flaky lane rather than a leak. Teardown now checks liveness from the OS, escalates
  SIGTERM → SIGKILL → tree-kill, and always finishes with a precise sweep by the client's own
  per-instance game dir; survivors are surfaced, never swallowed.
- **Proven on real boots:** a rendered Fabric 1.21.1 client types onto a real sign editor via the
  fallback and `waitForBlock` confirms the typed line in the block entity through server truth; on
  Paper, `waitForBlock` catches falling sand while the assert-once `getBlock` on the same state
  provably races (the negative control that makes the wait meaningful). Harness
  `tests/e2e/run-time-verbs.mjs` (5/5), wired into both e2e lanes.

### 2026-08-08 — Truth vocabulary: assert WHERE a block ended up and WHAT an item actually is
- **`expectProperties` on `getBlock`** — subset assertions against the authoritative **blockstate**
  (`{ facing: east }`). The block *type* is `oak_wall_sign` whichever face you clicked, so until now a
  placement test could not tell right from wrong; the properties already crossed the wire and nothing
  read them. A property the block does not have is a FAILURE, never a vacuous pass.
- **Block-entity data is finally populated.** `block.nbtJson` has been in the schema since M1 and was
  never filled; the Bukkit agent now emits both it and a pre-parsed `block.nbt` twin, read through
  `BlockState` (`Sign` front/back text, `Container` name/lock/items, `Skull`, `CreatureSpawner`,
  `Lectern`, plus plugin PDC keys under a namespaced `mc-test:` key). It is an **API-derived**
  document using vanilla NBT names — Bukkit exposes no raw NBT and the agent may not touch NMS — so an
  absent key means "not visible to this agent". Accordingly `expectNbt` FAILS on a block with no block
  entity rather than passing on nothing.
- **New `truth.getContainer` / `truth.getItem` (cap `worldTruth`) + the `getContainer`/`getItem` step
  verbs**, with **component-exact item identity**. `type` + `count` is not an identity: a Cobblemon
  Poké Ball, a ChestShop sign item and an ItemsAdder block are all vanilla materials plus data
  components, so comparing materials would call them equal to plain stacks. Every stack now carries a
  canonical `components` map (Bukkit's `ItemMeta#serialize()`, recursively normalized) and a
  `componentsHash` digest over `type` + components. Assertions come in three strengths — `components`
  (exact whole-map), `componentsInclude` (subset), `componentsHash` (digest) — plus `empty: true`.
  An empty slot is an explicit `item: null`, and a non-container block is `invalidParams`, never an
  empty container.
- **Honest about what the agent cannot see:** `components` absent means "this agent cannot read
  components" (distinct from `{}` = "it looked, there are none"), and a component assertion against
  such an agent FAILS. The digest is canonical (sorted keys, no whitespace, integral numbers without
  `.0`) so the same item hashes identically across reads instead of flaking.
- **Proven on a real Paper 1.20.4 boot** (`tests/e2e/truth-vocabulary.mctest.yml`, harness
  `tests/e2e/run-truth-vocabulary.mjs`, wired into the e2e lane): a sign sneak-placed on a chest's EAST
  face asserts `facing=east`, its `/data merge`-set text asserts through `expectNbt`, and two diamond
  swords of the same material and count in the same chest are told apart by their components. Two
  **negative controls** back it: the same sign on the NORTH face fails the facing assertion, and the
  plain sword fails the enchanted one's component check while still satisfying `type` + `count`.

### 2026-08-08 — World-interaction verbs: a test can now ACT on the world, not just on GUIs
- **New capability `worldInteraction`** (the 14th canonical matchable boolean, `PROTOCOL.md` §6.1) and
  five new canonical MCTP methods under it: **`world.useBlock`**, **`world.attackBlock`**,
  **`world.setHeldItem`**, **`world.look`**, **`world.move`**. Until now every verb went through a GUI,
  chat, or a truth read; the gameplay half of a plugin — placing, breaking, clicking blocks — had no
  vocabulary at all. `worldInteraction` (ACT as the player) is deliberately separate from `worldTruth`
  (READ authoritative state): in the canonical flow the bot places the sign and the *server agent*
  confirms where it landed, so neither half can rubber-stamp the other.
- **Authoring verbs `useBlock` / `attackBlock` / `setHeldItem` / `look` / `move`** in both surfaces
  (YAML + fluent), each gated on `worldInteraction` for per-step honest skips. Blocks are addressed by
  position + face — the one place coordinates are legal, since a block in the world has no label to
  select on; UI verbs remain selector-only.
- **The headless (Mineflayer) driver implements all five** and now advertises
  `chat, command, containerGui, typeText, pressKey, worldInteraction`. `sneak: true` genuinely holds
  sneak across the interaction (and long enough for the server to see the pose), which is what makes a
  held item place against the clicked face instead of opening the block.
- **Honest failure, not silent no-ops:** `world.setHeldItem` for an item the inventory does not contain
  is `ELEMENT_NOT_FOUND` (a quietly empty hand would turn every downstream placement assertion green),
  and an unloaded position is `WORLD_NOT_READY`. The **pixel/OCR stub advertises no `worldInteraction`**,
  so a scenario pinned to `driver: pixel` is skipped `NO_COMPATIBLE_DRIVER unmet=[worldInteraction]`
  before anything is booted.
- **Proven on a real Paper 1.20.4 boot** (`tests/e2e/world-interaction.mctest.yml`, harness
  `tests/e2e/run-world-interaction.mjs`, wired into the e2e lane): a bot sneak-clicks a chest's north
  face holding an oak sign, and the sign lands on that face — confirmed twice over, by the server's own
  `/execute if block` and by an authoritative MCTP `truth.getWorldBlock` when the Bukkit agent is
  co-selected. A **negative control** runs the identical scenario without `sneak` and asserts nothing is
  placed, so the positive run cannot be green by accident.

### 2026-08-05 — Nightly CI audit + failure notification; `doctor` becomes a real preflight
- **Audited the nightly E2E lane (45 runs, 2026-06-23 → 2026-08-04) and found a masked flake.** By
  workflow conclusion the nightly was 43/45 green; by *per-job* conclusion it was **35/45**. The
  `fabric-rendered-client` lane carries `continue-on-error: true`, which reports `success` to the
  `needs` context even when the job fails — so **8 real rendered-client failures were invisible**
  (2026-06-23/24/26/27, 07-02/05/10/11, 08-03). Every one is the same failure: the rendered harness'
  flake budget reporting `NONDETERMINISTIC`, with a `screenshot-failure-step7-click.png` artifact —
  a GUI-timing flake on the click step, ~18% of nights. The two runs that were red outright were
  transient upstream infra, not rot: a `repo.papermc.io` checksum mismatch on `Java-WebSocket-1.5.7`
  (2026-06-28) and an `ECONNRESET` in `download-artifact` (2026-07-30).
- **Added a `notify` job so a nightly failure can no longer pass unnoticed.** It reads the run's
  per-job conclusions from the API rather than `needs.*.result` — precisely because the latter is
  blind to `continue-on-error` lanes — and opens one tracking issue labelled `nightly-e2e`, comments
  on it for each subsequent failure, and **closes it automatically** when a run comes back fully
  green. It deliberately does not fail the workflow: keeping the fragile GL lane non-blocking is an
  intentional choice, so the fix is visibility, not a new gate. README gained CI + nightly badges
  with a note about that gap.
- **Fixed real version rot:** four of the five E2E lanes (and the CI lane) pinned `node-version: '20'`
  while `mineflayer`/`minecraft-protocol` declare `engines.node: ">=22"` — an `EBADENGINE` warning on
  every install and an unsupported runtime under the headless driver. All lanes and the root
  `engines.node` are now `22`; the docs' stated prerequisite moved from "Node.js 18+" to "Node.js 22+".
- **`mc-test doctor` is now a dependency preflight, and `mc-test run` performs it before booting.**
  New `packages/runner/src/doctor/Preflight.ts` derives what a session needs **from the selected
  targets** rather than a hardcoded list — a matrix with no `driver: inprocess` row is never asked for
  a display, and an agent jar nobody names is never demanded. It checks the JDK, free disk (thresholds
  scale for rendered/modded rows), the agent jars the targets name, Gradle (only when something still
  has to be built), and, for rendered rows, a local display **or** the pinned `mc-test/rendered:21`
  Docker image. `doctor` exits non-zero with a concrete fix for each unmet dependency (`--target`
  narrows the preflight, `--strict` also fails on warnings).
- **The preflight keeps honest skips honest.** Checks are split into blocking (no JDK, a full disk, an
  unparseable matrix — nothing truthful could come of the run) and non-blocking (an unbuilt agent jar,
  no display — these already degrade to a `skipped` with a reason). `run` aborts only on the former and
  merely warns on the latter, so capability negotiation still does its job; `--strict-preflight` refuses
  a degraded session outright and `--no-preflight` opts out.

### 2026-08-05 — Trust fixes: the `typeText` false-green, `results.json`, and an honest example
*(backfilled 2026-08-11 — these landed without CHANGELOG entries.)*
- **Killed the `typeText` false-green.** `screen.typeText` on a screen with no matching text field
  used to report success: the client agent computed a boolean and dropped it, so every "type into
  the sign" step was green against a screen that had swallowed the text. `ScreenHandlers.java` now
  propagates the miss as an `ELEMENT_NOT_FOUND` step failure, with a regression test that types at a
  screen with no text field and asserts the step FAILS. (The sign editor genuinely has no text
  widget — the honest `charTyped` fallback that makes signs typeable came on 08-08, deliberately
  after the false-green was closed rather than instead of closing it.)
- **`results.json` beside the JUnit XML** (spec 40 §6): the TYPED run artifact other tools parse
  instead of scraping XML or console text. Run-level `{ declared, executed, passed, failed, errored,
  skipped, coverage_model, target, sha }` plus one entry per case with its config, status, duration,
  failed step and evidence paths. Schema at `packages/runner/schema/results.schema.json`, gated by an
  ajv conformance test over a mixed pass/fail/error/skip run. A `fail` (an expectation broke) is kept
  distinct from an `error` (a step or the provisioning itself broke) — the distinction JUnit cannot
  express and every downstream verdict depends on.
- **The YAML stopped being fiction.** `mc-test.yml` parsing now WARNS on every key it does not
  implement (`collectUnknownKeys`, dotted paths, per target/plugin/mod entry) — silently accepting a
  key that does nothing is how a config file drifts into describing a product that does not exist.
  `mc-test.example.yml` was rewritten so every line both parses and is implemented, and a test pins
  it at zero unknown keys so it cannot drift again. README/GETTING_STARTED were corrected to claim
  exactly what runs — they were *under*-selling (rendered-client GUI tests on three loaders,
  server-truth assertions, premium-jar injection).

### 2026-06-22 — mc-test publishes its OWN report.html (dogfoods the consumer publish model)
- The E2E workflow (`.github/workflows/e2e.yml`) now publishes mc-test's own self-test report the same
  way the reusable consumer workflow (`mc-test-ci.yml`) does for downstream projects. A new
  `publish-report` job aggregates every lane's `mc-test-report/report.html` (Paper headless, the rendered
  Fabric/Forge/NeoForge client GUIs, the modded servers, the multi-loader matrix, the Gradle front door)
  into a single GitHub Pages site — a landing `index.html` linking each lane's report — and a best-effort
  `deploy-report` job (`upload-pages-artifact` → `deploy-pages`, `continue-on-error`) serves it at
  `https://<owner>.github.io/<repo>/`. Each lane's full report stays a downloadable artifact. One-time
  setup: repo Settings → Pages → Source "GitHub Actions". Documented in `docs/CI.md`.

### 2026-06-22 — All three RENDERED CLIENTS (Fabric/Forge/NeoForge) boot + GUI-test green; rendered-server routing fixed
- **Fixed an F5 regression that broke every rendered-client row.** `provisionServer` routed purely by
  `loaderFamily(loader)`, so a `*-client` row (which names the CLIENT loader, e.g. `fabric`, but boots a
  PAPER server via `server.paper`) wrongly took the modded path and resolved a Fabric server with
  `loaderVersion=undefined` → HTTP 400. The CLI already computed `serverIsBukkit` (true whenever
  `server.paper` is set) but never threaded it into the router. Now `provisionServer` honors an explicit
  `serverIsBukkit` (new pure helper `serverUsesBukkit`, unit-tested) and only falls back to the loader
  family — so client rows boot Paper, modded-server rows are unchanged.
- **All three rendered clients verified GREEN in Docker (`mc-test/rendered:21`, Xvfb + Mesa llvmpipe):**
  `fabric-1.21-client`, `forge-1.20.1-client` (modular launch on Java 17 / LWJGL 3.3.1), and
  `neoforge-1.21-client` (modular launch) each boot a real Minecraft client, drive the SUT mod's client
  `OpenRegions` Screen end-to-end (`/or` → click "Regions" → type a name → "Create" → chat
  "Region created" → click "TestRegion" → chat "Region loaded"), capture a screenshot, and confirm
  `assertPluginState regions.exists = true` via the co-selected Bukkit agent. The screenshot step now
  captures a real PNG (no longer honest-skips). Run them with
  `MC_TEST_RENDERED_HARNESS=tests/e2e/run-rendered-loaders.mjs bash scripts/run-rendered-docker.sh`.

### 2026-06-22 — Forge + NeoForge modded SERVER agents now built + booted + green
- **All three modded SERVER loaders (Fabric, NeoForge, Forge) now boot a real dedicated server and assert
  `mod.loaded = true` over MCTP via the cost-1 `server` driver (no player join).** The Forge/NeoForge
  server-mod truth agents are no longer acceptance-only/scaffolded: `agent-server-forge.jar` (ForgeGradle,
  MC 1.20.1, Forge 47.3.39, built on Java 17) and `agent-server-neoforge.jar` (NeoGradle, MC 1.21.1,
  NeoForge 21.1.234, built on Java 21) are **built and runtime-proven**. Each boots a real server,
  downloads FerriteCore from Modrinth into `mods/`, and reports `mod.loaded = true` GREEN; a negative
  control (asserting an absent mod) goes RED. Proof: `tests/e2e/run-modded-server-boot.mjs` prints
  "2/2 ... passed" and `mc-test-report/report.html` shows 3 cards passed (JUnit `tests=3 failures=0
  skipped=0`). The CI `e2e.yml` modded-server lane builds all three server agents (forge on Java 17) and
  runs the harness. Both agents remain **standalone Gradle builds kept out of `agents/settings.gradle.kts`**
  (they need network + a JDK), and `fakePlayers` stays intentionally unadvertised on forge/neoforge.
- **Mojmap method spellings build-verified.** The `mappings/Names.java` method spellings in each agent
  compiled against the real Forge 1.20.1 / NeoForge 1.21.1 Mojmap mappings and the lifecycle + `mod.loaded`
  path is runtime-proven, so the earlier "verify spelling" notes are resolved.
- **JPMS fix: neither agent bundles Gson anymore.** The loader/Minecraft already provides
  `com.google.gson` as a module on the boot module path, so bundling it split the module graph; Gson is
  now a compile-only dependency.
- **Boot-log mod-load signal is positive-only for the FML loaders.** Forge/NeoForge boot logs are used as a
  positive mod-load signal only, avoiding false negatives from their differing log formats.
- **World-truth + fixture surface now runtime-exercised on the modded servers (beyond `mod.loaded`).** A new
  `examples/regions/regions.worldtruth.mctest.yml` runs on all three modded-server rows and drives each
  agent's real `mappings/Names.java` paths over MCTP: authoritative block reads (`getBlock` asserts
  `minecraft:bedrock` at the flat world's bottom and `minecraft:air` above it), entity iteration
  (`getEntities`), and the no-player fixture recipes (`gamerule` / `time` / `weather`) plus `fixture` reset.
  Verified GREEN on real Fabric/Forge/NeoForge servers, with a negative control (`tests/e2e/worldtruth-negative.mctest.yml`)
  that asserts a wrong block id → RED. The `getBlock` step gains an optional **`expect`** (a block id) that
  turns the read into a real, case-insensitive world-state assertion; without it the read still exercises
  the full server-side path. Both are wired into `tests/e2e/run-modded-server-boot.mjs` (the CI lane).

### Added
- **F5 — modded SERVER support (v2): test server-side mods on real Fabric/Forge/NeoForge dedicated
  servers.** Until now only Bukkit-family servers (Paper/Spigot/Folia) could boot; `loader` was
  metadata-only in provisioning. A new loader-aware **`provisionServer` router** + **`ModdedProvisioner`**
  boot a real **Fabric/Quilt** server (a `fabric-server-launch.jar` resolved from the Fabric meta API by
  `loaderVersion`, or a pinned `server: { url|path, sha256 }`) and **Forge/NeoForge** servers (run the
  installer `--installServer`, then boot via the generated `@libraries/.../<os>_args.txt`). SUT mods +
  the server-truth agent drop into `mods/`; the agent port travels via `MCTEST_AGENT_PORT`. No display is
  needed (a server renders nothing), so these boot in plain CI. Because a Mineflayer bot can join a Fabric
  server but **cannot** complete Forge/NeoForge's FML handshake, the assertion runs over a new **cost-1
  `server` driver** — a server-truth-only session where the co-selected server agent is the primary
  connection and `join`/`leave` are no-ops (honest `NO_SERVER_AGENT` skip when no agent is co-selected).
  The headless driver now also advertises `fabric`/`quilt` (a vanilla bot connects to a Fabric server).
  (`provision/{provisionServer,ModdedProvisioner,serverCommon}.ts`, `drivers/DriverRegistry.ts`,
  `engine/{Runner,StepExecutor}.ts`, `driver-headless/capabilities.ts`.)
- **Loader-provided `mod.loaded` probe + a real `modrinth` source resolver — prove a DOWNLOADED mod
  loaded.** `truth.assertPluginState` gains reserved, SUT-agnostic queries `mod.loaded`/`plugin.loaded`
  (`{ id }`) resolved from the loader itself (`FabricLoader.isModLoaded` / `ModList.isLoaded` / Bukkit
  `PluginManager`) BEFORE the SUT `McTestStateProvider` (`agents/core` `BuiltInStateQueries` +
  `LoaderPresence`) — so a third-party mod with no mc-test coupling can be asserted present. The
  documented-but-unbuilt **`modrinth` resolver** is now runner-consumed (`{ modrinth: { project,
  version?, loader?, gameVersion? } }`, integrity via Modrinth's published sha512/sha1). A secondary
  **boot-log mod-load** signal (`expectMods` → `MOD_NOT_LOADED` gate; otherwise informational) surfaces in
  `report.html` + JUnit (`modsLoaded`/`modsMissing`). New agents `agents/server-forge` (ForgeGradle) +
  `agents/server-neoforge` (NeoGradle) mirror the (already-complete) `agents/server-fabric` — the only
  per-loader file is `mappings/Names.java` (CI import-scan extended to both). (`provision/modrinth.ts`,
  `provision/sources.ts`, `agents/core/{BuiltInStateQueries,LoaderPresence}.java`, `agents/server-*`.)
- **F5 tests: real-boot validated on Fabric, honest-skip on Forge/NeoForge.** `examples/regions/regions.modloaded.mctest.yml`
  (one server-truth-only file run across all three loaders) asserts `mod.loaded { id: ferritecore }`;
  `mc-test.yml` gains `fabric-server-1.21` / `neoforge-server-1.21` / `forge-server-1.20.1` rows downloading
  **FerriteCore** from Modrinth (and the nonexistent Forge `47.2.0` pin was corrected to `47.3.39`). The
  new e2e harness `tests/e2e/run-modded-server-boot.mjs` (+ matrix + `e2e.yml` `modded-server` job) boots
  each modded server and asserts mod-load over MCTP + boot-log, with a negative control (absent mod → RED)
  and per-loader honest-skip when an acceptance-only agent isn't built. **Verified end-to-end on this
  Windows box:** a real **Fabric 1.21.1** server boots, downloads FerriteCore via Modrinth, and
  `mod.loaded = true` GREEN over MCTP (forge/neoforge honest-skip — their agents are acceptance-only). New
  offline unit suites gate the pure parts in fast CI: `f5-server-driver`, `modrinth`, `modded-provision`,
  and `BuiltInStateQueriesTest` (`agents/core`). Full unit suite: **107 runner tests** green.
- **Canonical OpenRegions SUT built for every target + richer behavior.** `examples/regions` now exists in
  **four forms** — the Bukkit/Paper [plugin](examples/regions/plugin) plus a **Fabric**, **Forge**, and
  **NeoForge** client mod (`examples/regions/mod-{fabric,forge,neoforge}`; the old `mod` is renamed to
  `mod-fabric`) — so every loader row in the matrix drives a **real** SUT instead of reusing the Fabric jar
  as a placeholder. Behavior is enriched from one button to a **CRUD flow**: a multi-region list (seeded
  `TestRegion`/`Spawn`/`Market`) with load, **create-by-typing** a name (mods) / a preset Create (plugin),
  delete, and richer queryable state (`regions.exists`/`count`/`list`/`active`). The Forge/NeoForge mods are
  plain mods with **zero mc-test coupling**, driven purely by `label` + `role` selectors; the Fabric mod
  additionally exposes `TestIdHolder` testIds. All four artifacts build on this Windows box
  (`regions-plugin.jar` via Maven; `openregions-{fabric,forge,neoforge}.jar` via Loom/ForgeGradle/NeoGradle,
  the Forge jar reobfuscated to SRG). (`examples/regions/**`, `mc-test.yml`, `tests/e2e/*.matrix.yml`,
  `.github/workflows/e2e.yml`.)
- **Tests + mock peers updated to the CRUD flow in lockstep.** `regions.mctest.yml` (headless) and
  `regions.clientgui.mctest.yml` (rendered — now selecting by `label` + `role:input`, so the SINGLE file
  runs unchanged across Fabric/Forge/NeoForge) drive the richer flow; `regions.fluent.test.ts` stays `≡`
  the YAML; the scripted mock agent and the F1/F3 e2e harness markers were updated to match. Full unit
  suite green: **393 tests** (incl. the 217 protocol conformance fixtures + the fluent≡YAML equivalence).
  The headless plugin path is **real-boot-verified**: `tests/e2e/run-real-boot.mjs` boots real Paper
  1.20.4, drives the enriched CRUD flow via a Mineflayer agent, and passes **5/5** — the positive run green
  including `assertPluginState` (active/exists/count from real state), plus the truth/UI-divergence (→RED)
  and capability-skip controls. The rendered **Fabric** client now **PASSES for real, fully off-screen** (a
  Linux container under Xvfb + Mesa software GL — see `scripts/run-rendered-docker.sh`): the client agent
  drives the SUT's client `Screen` end-to-end to a GREEN result — `/or` → screen "OpenRegions" → click
  "Regions" → **type** "Sanctuary" → Create → assertChat "Region created" → click "TestRegion" → assertChat
  "Region loaded" → assertPluginState `regions.exists = true` (real server state) — with `screenshot`
  honest-skipped, after the join→command race and capability-union fixes below. Forge/NeoForge
  rendered boots stay opt-in (`MC_TEST_RENDERED_LOADERS`) with their SUTs built + wired and the same agent
  fix applied; the multi-loader orchestration harness passes 4/4 (honest skips).
- **F2 — native old-version support (v2):** old Minecraft versions now run on the headless path
  *without* a proxy. The bot connects at the target's `mc` natively (Mineflayer + minecraft-data
  span ~1.8–1.21), and the provisioner boots an explicit, integrity-checked
  `server: { url | path, sha256 }` jar — so a plugin-capable old server the PaperMC fill API cannot
  serve (e.g. a Spigot 1.8.x jar) is supported. (`engine/viaPreflight.ts`, `PaperProvisioner`
  `serverJar`.)
- **Multi-JDK provisioning (v2):** the provisioner selects/fetches the right Java for a target's MC
  version, so legacy servers no longer fail on a modern host JDK. `mc` maps to an acceptable Java
  range; the host `java` is used when it fits, else a configured (`provision.jdks`) / installed JDK,
  else an Eclipse Temurin build fetched from Adoptium into the cache (`provision.downloadJdks`,
  default `true`) and spawned via `javaPath`. (`provision/jdk.ts`.) Validated end-to-end: Temurin 8
  fetched + extracted + `java -version`-verified on Windows.
- **Spigot BuildTools server source (v2):** `server: { spigot: { version } }` builds a plugin-capable
  legacy server from source with Spigot BuildTools (the Paper API can't serve 1.8.x), run under the
  version's JDK (multi-JDK supplies Java 8) — the automated counterpart to bring-your-own
  `server: { url | path, sha256 }`. Needs `git` + network; cached as `spigot-<rev>.jar` (the Spigot rev
  can differ from the MC version, e.g. 1.8.9 → 1.8.8; a bad rev fails fast `SPIGOT_VERSION_NOT_FOUND`).
  Adds a runnable `spigot-1.8.8` target. Validated end-to-end on Windows: BuildTools built Spigot 1.8.8
  from source under a fetched Temurin 8 → 21 MB jar in ~3 min. (`provision/buildtools.ts`.)

### Changed
- **`via` is now advisory, not a blanket skip.** A `via: true` target only honest-skips
  `VIA_BRIDGE_UNAVAILABLE` when its `mc` is *outside* the bot's native range (genuinely needs
  ViaProxy — a deferred follow-on); in-range versions (incl. legacy like 1.8.9) connect directly.
  An out-of-range target without `via` is skipped by capability negotiation (`NO_COMPATIBLE_DRIVER`).
- **Headless driver — improved handling of custom items** in selector resolution: richer
  display-name / NBT normalization (`packages/driver-headless/src/normalize.ts`) and container-GUI
  element mapping (`primitives/containerGui.ts`), with a new `Target` field + `PaperProvisioner`
  wiring and a CLI flag. Adds headless-driver test coverage. (`6305f72`)

### Fixed
- **Rendered client on a desktop OS without Xvfb.** `startDisplay` now falls back to the **native
  desktop display** when an `xvfb` display is requested but `Xvfb` cannot be spawned (Windows/macOS, or
  a Linux box without it) — previously the boot died with `spawn Xvfb ENOENT`. Selection still honors an
  explicit `xvfb` pref; this is a runtime safety net so a `display: xvfb` matrix row also runs on a real
  desktop. Surfaced by the first real rendered boot on Windows. (`driver-inprocess/launch/Display.ts`.)
- **Fabric/Quilt client missing Fabric API.** The in-process driver now resolves + stages **fabric-api**
  into the rendered Fabric client's `mods/` (newest build for the target MC, from `maven.fabricmc.net`).
  The `client-fabric` agent AND the SUT mods hard-depend on it, so the client previously refused to launch
  (`HARD_DEP_NO_CANDIDATE … fabric-api`). Surfaced by the first real rendered boot.
  (`driver-inprocess/launch/ClientProvisioner.ts`.)
- **Client-agent join→command race (THE rendered-GUI blocker).** `world.join` returned as soon as the
  connection was *initiated*, but `client.player` stays null for several render ticks after — so a command
  or chat issued immediately after join (the canonical `/or`) ran while `client.player` was null and was
  **silently dropped** by `runCommand`/`sendChat`, so the SUT screen never opened and `waitForScreen` timed
  out. `joinServer` now **waits (off the render thread) for the player to spawn** before returning, in all
  three client agents (`agents/client-{fabric,forge,neoforge}/.../mappings/Names.java`). This — not the
  foreground/focus — was why the rendered clientgui flow never reached the GUI; with it, the off-screen
  Fabric run drives `/or` → screen → click → **type** → create → load → assertChat end-to-end.
- **Per-step capability union now reflects the LIVE grant, not the static descriptor.** A driver
  connection contributes its **session's granted** caps to the per-step union (like agents already did),
  so a step requiring a capability the agent did not live-grant honestly **skips** instead of failing —
  e.g. `screenshot` on a rendered client whose agent computed caps at startup before the framebuffer
  existed. (`engine/SessionGroup.ts`; the documented CAPABILITIES.md §4 follow-up.)

## [1.0.0] — 2026-06-16

First usable product: a generalized, Appium-style automated testing framework for **Spigot/Paper
plugins**, authored once in semantic steps and run against a real Paper boot. Internal/private release
(not published). Build phases F0–F6; protocol/driver milestones M1–M3.

### Added
- **MCTP contract** (`@mc-test/protocol`, M1): JSON-RPC 2.0 over WebSocket with Appium-style capability
  negotiation — method catalog, capability keys, selector keys, error model, and golden conformance
  fixtures. TS types and JSON Schema kept in sync by a CI drift gate. Plus an authoring JSON Schema for
  `.mctest.yml` step files.
- **Runner** (`@mc-test/runner`, bin `mc-test`, M2/F5): capability-driven driver selection, the
  `SelectorWaits` retry/poll engine, YAML **and** fluent authoring (one internal model), JUnit XML +
  HTML reporting, the `(test × target)` skip matrix, and `mc-test run | list | doctor | init`.
- **Headless driver** (`@mc-test/driver-headless`, M2): Mineflayer-based path for server-driven GUIs
  (chest / anvil / sign menus), chat, and commands; hosts its own MCTP WebSocket server.
- **server-bukkit agent** + **agents/core** (M3/F1): authoritative world-truth, deterministic fixtures,
  and `truth.assertPluginState` — **green against real Paper server state** (not just chat), via the
  two-connection `SessionGroup` fan-out. Bukkit/Paper API only (no obfuscation mappings).
- **Gradle / IntelliJ front door** (`io.mctest.mc-test`, F6): `./gradlew mcTest` builds the SUT jar,
  boots an ephemeral Paper server, and runs the suite from the IDE. Committed Gradle 9.4.0 wrappers.
- **Provisioning** (F1/F2): hardened Paper provisioner (EULA / `server.properties` forcing, port
  leasing, ordered teardown, `keepOnFailure`, readiness probes); `sha256`-verified `path` / `url`
  sources.
- **CI + foundation** (F0): fast-lane CI (TS + JVM gates, conformance replays, schema-drift gate,
  mappings import-scan) + a nightly / dispatch real-boot E2E lane; MIT `LICENSE`.
- **Negative controls** ("the tester doesn't lie"): truth/UI divergence → red, capability miss →
  honest skip, enforced in the suites.

### Notes — deferred to v2
The in-process **rendered-client** driver and `client-*` agents (real mod Screens), the
`(loader × version)` matrix (Forge / NeoForge / Fabric), **genuine** ViaProxy bridging, **genuine**
Carpet fake players, the pixel/OCR driver backend, and the `maven` / `modrinth` / `github` source
resolvers are scaffolded but not built or run — they **honestly skip** today (never a false green).
