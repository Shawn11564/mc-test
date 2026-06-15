# BUILD_PROMPT — Milestones 1–2 (copy-paste into Claude Code)

> This file is the exact prompt to paste into Claude Code to dispatch build agents for **M1 + M2**.
> Everything below the line is the prompt. It is self-contained; paste it verbatim.

---

ultracode

You are building **Milestones 1 and 2** of `mc-test`, a WebDriver/Appium-style automated testing
framework for Minecraft plugins/mods. Work in the repo rooted at this project.

## STEP 0 — Read the contract FIRST (do not skip)

Before writing any code, read, in this order:

1. `/CLAUDE.md` — prime directives, repo layout, conventions, the "regions" example, the rules
   checklist. Obey it.
2. `/docs/ROADMAP.md` — **the authoritative build order, scope, and acceptance criteria.** §2 defines M1 in full
   (method catalog, capability keys, selector keys, error codes, acceptance criteria); §3 defines M2 in
   full (runner + headless driver scaffolding, the canonical YAML/fluent test, step→MCTP mapping,
   minimal provisioning, acceptance criteria); §7 is the "testing the tester" strategy.
3. The docs that own each area you touch: `/docs/PROTOCOL.md` (envelopes/methods/errors/events),
   `/docs/CAPABILITIES.md` (capability registry + negotiation/skip shapes + JUnit mapping),
   `/docs/SELECTORS.md` (selector grammar + normalization + resolver contract), `/docs/DRIVERS.md`
   (driver shapes), `/docs/ENVIRONMENTS.md` (`mc-test.yml` schema + provisioning).

**Naming (resolved — ratified 2026-06-15).** The MCTP wire vocabulary is **namespaced `noun.verb`
methods with `lowerCamelCase` fields**, and **`/docs/PROTOCOL.md` is the single source of truth** for
every method, capability key, selector key, and error code. The canonical M1 surface is restated
verbatim in the M1 section below; `/docs/ROADMAP.md` §2–§3 scopes the milestones and acceptance criteria
using these same names, and §3.3/§3.4 give the authoring step verbs. Use these spellings exactly — never
invent a synonym. If you must change a wire name, change `/docs/PROTOCOL.md` first and update every
dependent doc in the same change (keep `/docs` in sync).

## SCOPE — strictly M1 and M2 only

Build exactly these, and nothing from later milestones (no `/agents/*`, no `driver-inprocess`, no
rendered client, no `world-truth`/`fixtures`/`fakePlayers` implementations — those are M3+):

### M1 — `/packages/protocol` (`@mc-test/protocol`): the MCTP contract

Pure data + functions. **No** dependency on any game, Mineflayer, or the JVM. Scaffold per ROADMAP
§2.1:

```
/packages/protocol
  package.json            # name: @mc-test/protocol
  tsconfig.json
  src/
    mctp.ts               # TS types for envelopes (request/success/error/notification), params, results, errors
    capabilities.ts       # capability key union + RequiredCapabilities/Capabilities types + matchCapabilities()
    selectors.ts          # Selector type (semantic selector union) + describeSelector()
    methods.ts            # MethodName string-literal union + MctpMethods[name]={params;result} compile-time map
    index.ts              # public barrel export
  schema/
    mctp-request.schema.json
    mctp-response.schema.json
    mctp-notification.schema.json
    capabilities.schema.json
    selector.schema.json
    methods/              # one request+result schema pair per method (session.create.schema.json, ...)
  fixtures/
    conformance/          # golden request/response JSON, used by every driver's test suite
  README.md
```

Required content (ROADMAP §2.3–2.6):
- **Method catalog** = the complete M1 surface from ROADMAP §2.3: session/lifecycle
  (`session.create`, `session.describe`, `session.close`, `session.ping`); world entry
  (`world.join`, `world.leave`, `world.sendChat`, `world.runCommand`, `world.waitForChat`); screen
  primitives (`screen.get`, `screen.listElements`, `screen.clickElement`, `screen.typeText`,
  `screen.pressKey`, `screen.screenshot`, `screen.waitForScreen`, `screen.close`); world-truth
  (`truth.getWorldBlock`, `truth.getEntities`, `truth.assertPluginState`); fixtures/doubles
  (`fixture.set`, `fixture.reset`, `player.spawnFake`, `player.despawnFake`); notifications
  (`event.chat`, `event.screenChanged`, `event.log`, `event.disconnected`).
- **Capability keys** exactly per ROADMAP §2.4: `chat`, `command`, `containerGui`, `clientScreens`,
  `screenshot`, `rendering`, `worldTruth`, `pluginState`, `fixtures`, `fakePlayers`, `typeText`,
  `pressKey`, `testIdTags`, `loader` (enum), `mcVersionRange` (string). `matchCapabilities(required,
  advertised) → { ok: boolean; unmet: string[] }`, pure.
- **Selector keys** exactly per ROADMAP §2.5 (all present keys ANDed): `label`, `text`, `textContains`,
  `loreContains`, `itemType`, `role` (`button|slot|label|input|tab|list|listItem`), `index`, `nth`,
  `within`, `testId`. `describeSelector(s): string` for skip/error messages.
- **Error model** exactly per ROADMAP §2.6: `-32000` ELEMENT_NOT_FOUND, `-32001` AMBIGUOUS_SELECTOR,
  `-32002` METHOD_NOT_SUPPORTED, `-32003` TIMEOUT, `-32004` WORLD_NOT_READY, `-32005` FIXTURE_FAILED,
  `-32006` ASSERT_FAILED, `-32099` PROTOCOL_VERSION_UNSUPPORTED, plus standard JSON-RPC
  `-32700/-32600/-32601/-32602`. Runner-level skip reason `NO_COMPATIBLE_DRIVER` carrying `unmet[]`.
- **Key types** exported: `ScreenSnapshot`, `Element`/`ElementRef`, `Entity`, `RequiredCapabilities`,
  `Capabilities`, `Selector`, `Test`, `Step`, `Target`, `MethodName`.
- **Transport/handshake constants:** JSON-RPC 2.0 over WebSocket; runner = client, driver/agent =
  server; `session.create` negotiates `protocolVersion` starting `"1.0"`.

### M2 — `/packages/runner` + `/packages/driver-headless` (runnable end-to-end)

Make the whole loop alive headless via Mineflayer against `/examples/regions`. World-truth/pluginState
are NOT implemented here — the headless driver does **not** advertise them, so the truth half of the
regions test **honestly skips** until M3. Scaffold per ROADMAP §3.1:

```
/packages/runner            # name: @mc-test/runner ; bin: mc-test
  src/
    cli.ts                  # mc-test run | list | doctor
    config/loadMatrix.ts    # parse + validate mc-test.yml
    config/loadSteps.ts     # parse *.mctest.yml step files
    model/{Test,Step,Target}.ts
    engine/Runner.ts        # select driver, run steps, retries, waits
    engine/SelectorWaits.ts # poll/retry wrapping selector-bearing steps (intervalMs def 250, timeoutMs def 5000)
    engine/CapabilityMatch.ts  # uses @mc-test/protocol matchCapabilities
    engine/Session.ts       # MCTP JSON-RPC client over ws
    drivers/DriverRegistry.ts  # capability-keyed driver selection (NO hard-coded "use headless")
    drivers/MctpClient.ts   # ws + JSON-RPC 2.0 framing
    report/JUnitReporter.ts # JUnit XML
    report/Artifacts.ts     # logs / (screenshots/video on failure)
    authoring/fluent.ts     # write-once fluent API: test().requires().join().command().click()...
  README.md

/packages/driver-headless   # name: @mc-test/driver-headless
  src/
    HeadlessDriver.ts       # boots Mineflayer, hosts an MCTP WebSocket server (default ws://127.0.0.1:0)
    primitives/world.ts     # world.join/leave/sendChat/runCommand/waitForChat
    primitives/containerGui.ts  # screen.* mapped onto Mineflayer window/inventory
    primitives/selectorResolve.ts  # Selector -> inventory slot (display-name / lore / itemType)
    via/viaProxy.ts         # OPTIONAL ViaVersion/ViaProxy front for version spanning
    capabilities.ts         # advertises: chat, command, containerGui, typeText, pressKey (NOT screenshot/worldTruth/...)
  README.md

/examples/regions
  README.md                 # how to stand up the minimal target
  plugin/                   # minimal "regions" plugin (id OpenRegions): /or -> GUI -> "Regions" -> "TestRegion", says "Region loaded"
  world-snapshot/           # pristine world copied per test
  regions.mctest.yml        # the canonical step file (test name: regions-open-testregion)
  regions.fluent.test.ts    # the same test in the fluent API
```

- **Authoring (write once).** The canonical YAML step file and the fluent test are spelled out verbatim
  in ROADMAP §3.3 — reproduce those field names exactly. Step verbs and their MCTP mapping are ROADMAP
  §3.4 (`join`→`world.join`, `command`→`world.runCommand`, `waitForScreen`→`screen.waitForScreen`,
  `click`→`screen.clickElement` wrapped by `SelectorWaits`, `assertChat`→`world.waitForChat`,
  `assertPluginState`→`truth.assertPluginState`, …). Both authoring surfaces compile to the SAME
  internal `Test`→`Step[]` model and run identically.
- **Protocol-first headless driver.** The headless driver hosts a real MCTP WebSocket server; the runner
  connects as a client exactly as it will to a JVM agent. The runner must have **zero** special-casing
  for headless vs. agent — same `MctpClient`, same envelopes, same conformance fixtures (ROADMAP §3.2).
- **Capability-driven selection.** Driver choice flows through `DriverRegistry` + `matchCapabilities`
  from `@mc-test/protocol`. No hard-coded "use headless" branch.
- **Minimal provisioning** (ROADMAP §3.5): download a Paper jar from the Paper API (fall back to the
  Mojang version manifest); write `server.properties` with `online-mode=false`, `eula=true`; copy
  `examples/regions/world-snapshot/` to a fresh temp dir per test; drop the regions plugin jar into
  `plugins/`; boot, wait for "Done", run the suite, shut down, collect logs. Full Testcontainers/Docker
  and agent installation are M3+ — do NOT build them now.
- **Monorepo plumbing.** Set up an npm **workspaces** root `package.json` covering `packages/*`,
  shared/base `tsconfig.json` with project references, and `@mc-test/*` scoping. `@mc-test/protocol`
  must build standalone with `tsc --strict`. `runner` and `driver-headless` depend on `protocol`
  (never the reverse).

## DELIVERABLES (concrete)

- Working npm-workspaces monorepo: root `package.json` + `tsconfig.json`; `packages/protocol`,
  `packages/runner`, `packages/driver-headless` each with their own `package.json`/`tsconfig.json` and
  a buildable `tsc --strict`.
- `@mc-test/protocol` published surface: `mctp.ts`, `capabilities.ts` (`matchCapabilities`),
  `selectors.ts` (`describeSelector`), `methods.ts` (`MethodName` + `MctpMethods`), `index.ts`; the JSON
  Schemas under `schema/` including a per-method request+result pair under `schema/methods/`; the
  golden conformance fixtures under `fixtures/conformance/`.
- `mc-test` CLI with `run`, `list`, `doctor`. `run` executes a step file (or matrix selection) and emits
  JUnit XML + an artifacts bundle.
- `/examples/regions` minimal target: a real minimal "regions" plugin (id `OpenRegions`) that opens a
  server-driven inventory GUI with a "Regions" button leading to a "TestRegion" entry and prints
  "Region loaded" to chat on selection; a pristine `world-snapshot/`; `regions.mctest.yml`;
  `regions.fluent.test.ts`.
- A root or example `mc-test.yml` (or documented `--target`) defining at least the `paper-1.20.4`
  headless target (canonical field names per ROADMAP §6.2 / `docs/ENVIRONMENTS.md`).
- README per package.

## ACCEPTANCE CRITERIA (must all hold; copied from ROADMAP §2.7 + §3.6)

M1:
- [ ] `@mc-test/protocol` builds with `tsc --strict` and ships `.d.ts` + the JSON Schemas.
- [ ] Every method in the catalog has a TS param type, a TS result type, and a JSON Schema pair under
      `schema/methods/`. `methods.ts` exports `MethodName` and the `MctpMethods[name]={params;result}`
      map.
- [ ] `capabilities.ts` exports the capability key union and a pure, unit-tested
      `matchCapabilities(required, advertised) → { ok, unmet[] }`.
- [ ] `selectors.ts` exports `Selector` and a pure `describeSelector(s): string`.
- [ ] A conformance fixture suite under `fixtures/conformance/` validates against the schema in CI
      (`validate-fixtures.test.ts`): ≥1 golden request and ≥1 golden success/error response per method.
- [ ] TS types and JSON Schema are proven **in sync** (generator/round-trip test fails CI on drift).
- [ ] No dependency on any game, Mineflayer, or the JVM.

M2:
- [ ] `npx mc-test run examples/regions/regions.mctest.yml --target paper-1.20.4` **boots a Paper
      server, joins with Mineflayer, runs `/or`, clicks "Regions" then "TestRegion", asserts chat
      contains "Region loaded", and writes a green JUnit case** — fully unattended, `online-mode=false`.
- [ ] The **same** test via the fluent API (`regions.fluent.test.ts`) produces an identical pass.
- [ ] The `assertPluginState` step is reported `skipped` with reason `NO_COMPATIBLE_DRIVER`
      (`unmet:["pluginState"]`) — proving honest skips and setting up M3.
- [ ] JUnit XML validates and is consumed cleanly by stock CI; on failure an artifacts bundle (server
      log + last chat lines) is attached (no screenshot — headless).
- [ ] Driver selection is capability-driven via `DriverRegistry` + `matchCapabilities` — no hard-coded
      "use headless" branch.
- [ ] The headless driver passes the M1 conformance fixtures for every method it advertises.

## ADVERSARIAL SELF-VERIFICATION (do this BEFORE claiming done)

A test framework that lies is worse than none. You must actually RUN the thing and observe a REAL
pass/fail — do not infer success from "it compiles."

1. Build every package with `tsc --strict`; fix all type errors. Run the protocol unit tests and the
   conformance-fixture validation; they must be green.
2. Actually execute `npx mc-test run examples/regions/regions.mctest.yml --target paper-1.20.4`. It must
   boot Paper, join, click through, and emit a green JUnit `<testcase>` with the `assertPluginState`
   step recorded as `<skipped>` with `unmet:["pluginState"]`. Inspect the emitted JUnit XML and the
   server log to confirm the assertions really fired against runtime state (chat actually contained
   "Region loaded").
3. Run the **mutation negative control** (ROADMAP §7.3): in a throwaway build, rename the GUI button
   "Regions" → "Zones" and re-run; the test MUST go **red** with `ELEMENT_NOT_FOUND` for
   `label="Regions"`. Restore afterward. (This proves selectors actually bind to UI, not to a stub.)
4. Run the fluent variant and confirm it produces the identical verdict to the YAML variant.
5. Confirm the headless driver advertises only its real capabilities (`chat`, `command`,
   `containerGui`, `typeText`, `pressKey`) and that a step requiring `screenshot`/`pluginState` skips
   with a precise reason rather than passing.

If you cannot get a real boot in this environment (e.g. no JVM/network), say so explicitly, leave the
run path implemented and documented, and provide a mock-agent-backed end-to-end test
(`packages/runner/test/mockAgent.ts`, ROADMAP §7.2) that exercises the full engine
(capability match → step→MCTP mapping → `SelectorWaits` retry/timeout → JUnit output) so the loop is
proven without a live server. Do not claim the M2 acceptance criteria are met if you could not run the
real boot — report exactly which criteria are verified and which are blocked and why.

## HARD CONSTRAINTS (from the prime directives)

- **Names/paths must match the design docs** (ROADMAP-authoritative). Methods, capability keys,
  selector keys, error codes, step verbs, `mc-test.yml` fields, package names (`@mc-test/*`,
  bin `mc-test`), and file paths are all fixed by `/docs`. Reuse them; never invent synonyms.
- **Protocol-first:** everything crossing the waist goes over MCTP/WebSocket/JSON-RPC 2.0. The runner is
  the client; the headless driver is a real MCTP server. No bypass.
- **Tiny dumb agents / intelligence outside:** selectors, retries/waits, assertions, orchestration, and
  reporting live in the runner — never in a driver/agent. `SelectorWaits` (not the agent) retries
  `ELEMENT_NOT_FOUND` until timeout.
- **Semantic selectors only:** no slot indices or pixel coordinates anywhere in a test.
- **Honest skips beat false greens.**
- **Keep `/docs` in sync** with any contract change you make, and reconcile cross-doc naming toward
  ROADMAP.
- Stay in scope: **M1 + M2 only.** No M3+ agents, no rendered client, no real world-truth/fixtures.

When done, report: which packages were scaffolded, the exact command(s) you ran to verify, the real
pass/fail/skip outcome you observed (with the JUnit snippet), which acceptance criteria are verified vs.
blocked (and why), and any doc inconsistencies you reconciled.
