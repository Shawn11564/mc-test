# Changelog

All notable changes to this project are recorded here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims to follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> mc-test is currently **internal/private** (decision **D1**, 2026-06-16): the `@mc-test/*` packages are
> not published to npm and the agent jars are not attached to GitHub Releases. Version tags are internal
> release markers. Revisit publishing for v2.

## [Unreleased]

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
