# mc-test — v1.0 Plan (the first usable product)

> Status: **v1.0 implemented** — F0–F5 are done and **merged to `main`** via PR #1 (merge `4760b90`,
> 2026-06-16). The first GitHub CI run surfaced **two real failures** (CLI `--help` exited 2; the
> `gradle-plugin` build failed `validatePlugins`); both are now **merged via PR #2 (`dc3d82e`)** and
> **fast-lane CI is green on `main`** (the "Test core + server-bukkit" *cancellation* was a benign
> concurrency artifact of a superseded run, not a test failure). The real-boot E2E lane runs
> nightly/dispatch. See the **[Status](#status--v10-implemented--2026-06-16)** section below for
> exactly what's done, what remains, and how to resume. This is the **scoped, sequenced plan for the
> first usable product**, derived from
> `FINALIZATION.md` after the v1.0 scope was ratified (2026-06-16). `FINALIZATION.md` enumerates the full
> path (phases F0–F7) and the open scope decisions; **this document locks the decisions and the build
> order for v1.0** and is authoritative only for that. All wire names, capability keys, selector keys,
> error codes, and `mc-test.yml` fields are defined canonically in `PROTOCOL.md` / `ENVIRONMENTS.md` /
> `ROADMAP.md`; this doc defers to them.

## Ratified scope decisions (2026-06-16)

| Decision | Choice | Consequence |
|----------|--------|-------------|
| **D2 — product scope** | **Paper/Spigot PLUGIN slice only.** Headless bot + `server-bukkit` truth agent. | Rendered-client mods (`F3`) and the multi-loader matrix (`F4`) are **v2** — out of scope. ~70% of remaining engineering is deferred. |
| **IDE front door** | **Include `F6`.** `./gradlew mcTest` from IntelliJ is part of v1.0. | The Gradle/IntelliJ front door is treated as "usable," not a nicety (user develops in IntelliJ). |
| **D1 — distribution** | **Decide later.** Build the engineering now; defer the public-OSS-vs-internal publish call. | `F0` does CI + release *plumbing* + a `LICENSE`, but does **not** npm-publish publicly. A "release gate" at the end makes the call. |

## What v1.0 ships

> Author a plugin GUI test once — `join → /or → click "Regions" → click "TestRegion" → assert chat
> contains "Region loaded" AND assert region "TestRegion" exists server-side` — run it on Paper across
> versions via the headless bot + `server-bukkit` truth agent, and get a JUnit report. Runnable from the
> **CLI** (`npx mc-test run …`) **or** **`./gradlew mcTest`** in IntelliJ.

**Out of scope for v1.0 (→ v2):** the in-process client driver and client-* agents (rendered mod
Screens), the Forge/NeoForge/Fabric `(loader × version)` matrix, the pixel/OCR driver, and the
vanilla/Fabric/Forge/NeoForge **server** source resolvers (only needed for mods).

## Build order

```
F0 ──► F1 ──► F6 ──► (release gate: decide OSS vs internal → publish or keep private)
        │
        ├──► F2 (Via)      ← parallelizable after F1
        └──► F5 (docs)     ← runs alongside from F1; finalized last
```

| Phase | Theme | Size | Depends on |
|-------|-------|------|-----------|
| **F0** | CI + release foundation | S | — |
| **F1** | Make the Paper/plugin product real | S–M | F0 |
| **F6** | IntelliJ / Gradle front door | S–M | F1 (F0 ideally) |
| **F2** | ViaProxy — old Paper versions only | S–M | F1 |
| **F5** | User docs + DX | M | alongside F1+ |

> F2 vs F6 ordering is flexible — both only need F1 and are independent of each other. F6 is placed first
> because the IntelliJ front door is the stated v1.0 requirement.

---

## Status — v1.0 implemented ✅ (2026-06-16)

**The locked order F0 → F1 → F6 → F2 → F5 is implemented and verified.** F0–F5 are **merged to `main`**
(PR #1, merge `4760b90`); the CI-failure fixes (CLI `--help`, `gradle-plugin` validation, job timeouts,
this doc) are **merged via PR #2 (`dc3d82e`)** and **fast-lane CI is green on `main`** (the real-boot E2E
lane runs nightly/dispatch). The Paper/Spigot plugin product is real: a real Paper boot
drives the regions GUI and asserts server truth, runnable from the CLI **and** `gradle mcTest`. The
per-phase sections below are the original spec; **this table is the source of truth for status.**

| Phase | Status | Commit(s) | Delivered (verified on real boots) |
|-------|--------|-----------|------------------------------------|
| **F0** CI + foundation | ✅ scaffolded | `edf88ee` | `ci.yml` (TS + JVM gates) + `e2e.yml` (real-boot / `gradle mcTest`, nightly); `LICENSE` (MIT); `package-lock.json`. Both lanes validated locally. *Loose ends → Resume #1, #3.* |
| **F1** Paper/plugin real | ✅ done | `9725e6c` | Real Paper boot: `assertPluginState` green vs real `RegionStore`; honest-skip + truth/UI-divergence controls; fixtures; `keepOnFailure` cleanup. Committed harness `tests/e2e/run-real-boot.mjs` (5/5) + N=3 flake budget. |
| **F6** IntelliJ/Gradle | ✅ done | `8639284`, `7a6ff52` | `gradle-plugin/` (`io.mctest.mc-test`): `gradle mcTest` builds the jar → boots Paper → green (verified). Authoring JSON Schema; sample `examples/regions/plugin-gradle`; CI-wired. |
| **F2** old-version honesty | ✅ done | `0ca0586` | `via:true` → honest skip `VIA_BRIDGE_UNAVAILABLE`; old plugin target w/o a Paper build → `UNSUPPORTED_TARGET` skip (no vanilla false-green); `sha256`-verified `path`/`url` sources. |
| **F5** user docs + DX | ✅ done | `692800c` | `GETTING_STARTED.md` + `AUTHORING.md`; `mc-test init` / richer `doctor`; HTML report; dependency-ordered root `npm run build`. Documented flow verified green. |

**Verified:** ~307 TS tests + the JVM agent tests green; `npx mc-test run examples/regions/regions.mctest.yml
--target paper-1.20.4` → PASSED incl. `assertPluginState`, with `mc-test-report/report.html`. Real boots
ran on the local Windows machine (JDK 21 / Gradle 9.4.0 / Maven 3.9.6).

### Resume here — remaining for v1.0 "done"

1. ~~**Land the CI fixes on `main`.**~~ ✅ **done** — the first GitHub CI run was **red** on two real steps
   (CLI `--help` exited 2 in the fast-lane "CLI smoke test"; `gradle -p gradle-plugin build` failed
   `validatePlugins`). Both are **merged via PR #2 (`dc3d82e`)** and **fast-lane CI is green on `main`** (the
   one open F0 acceptance box → the green **badge**). The real-boot E2E lane runs nightly/dispatch.
2. ~~**Make the D1 distribution call**~~ ✅ **decided (2026-06-16): internal/private for v1.0.** Root
   `package.json` stays `private: true`; **no** npm publish of `@mc-test/*`, **no** GitHub Releases of the
   agent jars. This satisfies the release gate's "or keep private" branch with no code change and is fully
   reversible. **Revisit for v2** — going public OSS would then unblock, in order: npm publish + agent-jar
   Releases; **zero-Node-setup** for `gradle mcTest` (auto Node provisioning + the published runner — the
   F6 deferral); flipping `private: true → false`.
3. **Small F0 leftover:** the MCTP `protocolVersion` bump policy is documented in **PROTOCOL.md §10
   (Protocol versioning)**, now framed there as the release compatibility contract.
4. ~~**(Optional) commit a Gradle wrapper**~~ ✅ **done** — wrappers pinned to Gradle 9.4.0 are committed
   under `agents/`, `gradle-plugin/`, and `examples/regions/plugin-gradle/`, so the documented `./gradlew
   mcTest` works without a system Gradle (a `.gitattributes` keeps `gradlew` LF for Linux CI). CI still
   provisions Gradle via `gradle/actions/setup-gradle`.

### Out of scope for v1.0 (→ v2)

F3 (rendered-client mods), F4 (multi-loader matrix), genuine ViaProxy bridging, genuine fake players (needs
Carpet), and the `maven`/`modrinth`/`github` source resolvers — all **v2**. **Update (2026-06-16): F3 and
F4 are now implemented** as v2 work (rendered Fabric client; loader-aware in-process driver for
forge/neoforge + per-target parallelism + the full-matrix orchestration), with the rendered loader boots
**CI-gated** (`fabric-rendered-client` + `multi-loader-matrix` lanes) — see `FINALIZATION.md` §5–§6. The
rest (genuine Via bridging, Carpet fake players, the extra source resolvers) remain scaffolded/coded but
not built or run — they honestly **skip** today (never a false green).

### Definition of done (v1.0) — checklist

- [x] Canonical regions test real-green incl. `assertPluginState` on Paper; truth/UI-divergence + honest-skip controls enforced (committed in `tests/e2e/`).
- [x] Runnable via `npx mc-test` **and** `gradle mcTest`; `LICENSE` + Getting-Started docs.
- [x] Headless driver + `server-bukkit` agent green against the M1 conformance fixtures.
- [x] No false greens — old-version / `via` / pixel paths honest-skip, surfaced in the skip matrix.
- [x] Docs match the shipped product.
- [x] **CI green on every push** — fast-lane CI green on `main` (PR #2, `dc3d82e`); the real-boot E2E lane
      runs nightly/dispatch.
- [x] **Release gate decided + executed** — D1 = **internal/private for v1.0** (root stays `private: true`;
      no npm publish / Releases). Reversible; revisit for v2 (Resume #2).

---

## F0 — CI + release foundation

The TS + Java suites are already green; F0 *enforces* them and makes the repo installable.

- **Fast lane (free hosted runner, every push/PR):**
  - `npm ci` → **protocol drift gate first** (`npm run test -w @mc-test/protocol`, source-only — must run
    before any `gen:schema`/`build` regenerates the committed schema and masks drift) → `npm run build
    --workspaces` → `npm run typecheck --workspaces` → `npm test --workspaces` (this already includes the
    schema-sync drift gate, the M1 conformance replays, `validate-fixtures`, and the mappings import-scan
    in `m4`/`m5.test.ts`).
  - Java: `gradle -p agents :core:test :server-bukkit:test` on **JDK 21** (toolchain) / release 17. No
    Gradle wrapper exists yet → CI uses `gradle/actions/setup-gradle` with a pinned Gradle version.
- **Real-boot lane (`workflow_dispatch` + nightly):** boot Paper 1.20.4, run the canonical regions test,
  assert green JUnit, upload `mc-test-report/` + server logs. In F0 this runs the M2 **headless-only**
  payload (`assertPluginState` honestly skips); **F1 gives it the agent half**. Kept off the per-PR path
  so PRs stay fast and the repo isn't red before F1 wires the full payload.
- **Foundation:** add a `LICENSE` file (repo already declares MIT; resolves the README "TBD" — keeps the
  OSS option open without committing to publish); commit `package-lock.json` so CI uses `npm ci`; document
  the MCTP `protocolVersion` bump rules (`PROTOCOL.md` §10) as the release contract.
- **Deferred to the release gate:** actual npm publish + GitHub Releases of agent jars.

**Acceptance:** green fast-lane CI on `main`; `npx mc-test --help` works from a clean checkout following
the README (note: requires a build first, since `bin` → `dist/cli.js`).

## F1 — Make the Paper/plugin product real *(highest value; mostly wiring)*

Closes the M3 real-boot boxes that are currently only mock-green (`ROADMAP.md` §4.5).

- **Co-select the bukkit agent in a real boot:** drop `mc-test-agent-bukkit.jar` into `plugins/` on its
  second MCTP port, run `--target paper-1.20.4`, confirm `assertPluginState regions.exists{TestRegion}`
  goes **green against real server state** (not just chat).
- **Negative controls in CI** (the "tester doesn't lie" checks): truth/UI-divergence (GUI says "loaded"
  but the fixture creates no region → `assertPluginState` red) and honest-skip (no agent →
  `unmet:[pluginState]`).
- **Fixtures + fake players for real:** `fixture.set`/`reset` + `player.spawnFake` (Carpet) on a real
  Paper(+Carpet) boot; verify the world-snapshot reset leaves pristine state.
- **Harden the provisioner:** EULA/`server.properties` forcing, port leasing under concurrency, ordered
  teardown, `keepOnFailure` artifact retention, boot-timeout/readiness probes (no fixed sleeps).
- **Flake budget:** Paper E2E N=3 nightly with a nondeterminism alarm.

**Acceptance:** `npx mc-test run examples/regions/regions.mctest.yml --target paper-1.20.4` on a clean
machine → green **including** `assertPluginState`; both negative controls behave in CI.

## F6 — IntelliJ / Gradle front door

A thin JVM front door over the Node engine — **do not reimplement the runner on the JVM**.

- **`mc-test-gradle` plugin:** registers `mcTest` (+ per-target `mcTest<Target>`) that `dependsOn` the SUT
  jar task (`jar`/`shadowJar`) → runs the runner against an ephemeral instance; surfaces in IntelliJ's
  Gradle tool window (gutter ▶, auto run-configs).
- **Node bootstrap:** the plugin provisions a pinned Node + `@mc-test/runner` so a JVM dev never touches
  npm. *(Distribution deferred → vendor a runner tarball now; switch to the published package once F0's
  release gate opens.)*
- **Config + co-located tests:** a small `mcTest { targets, testDir, reportDir }` extension or
  auto-discovery of `mc-test.yml` + a co-located test dir (`src/mctest/`); the SUT jar path is wired from
  the build graph, never hand-edited.
- **Authoring schema:** ship a **JSON Schema for the `.mctest.yml` step-file format** and register it for
  IntelliJ YAML autocomplete + validation (mc-test ships wire/method schemas today but no *authoring*
  schema).
- **SPI scaffolding:** document + scaffold `McTestStateProvider` / `McTestFixtureProvider` registration
  (Java or Kotlin) so `assertPluginState`/fixtures resolve against real state.
- **CI wiring:** `mcTest` participates in `./gradlew check`; JUnit lands where IntelliJ/CI reporters
  expect.
- **Stretch (defer if tight):** `mcTestWatch` warm dev loop; JUnit 5 `TestEngine` for a native green/red
  test tree; optional Kotlin/Java authoring DSL.

**Acceptance:** in a sample Paper plugin project, applying the plugin + a co-located `.mctest.yml` →
`./gradlew mcTest` (or ▶ in IntelliJ) builds the jar, boots an ephemeral server, runs the test, shows
JUnit — with step-file autocomplete and **no manual Node setup**.

## F2 — ViaProxy for old Paper versions *(scoped down)*

Only the Via slice — the vanilla/Fabric/Forge/NeoForge **server** resolvers are v2 (mods only).

- Make `via: true` real: stand up ViaProxy so modern Mineflayer speaks old protocols; prove `paper-1.8.9`
  **or honest-skip with a precise reason** (never a dubious pass).
- Pin Via/Mineflayer/minecraft-data per target; a Via bump is a matrix change gated by the golden E2E.
- Modrinth/URL/sha256 source verification for third-party plugin deps.

**Acceptance:** `paper-1.8.9` runs, or honest-skips with a reason visible in the skip matrix.

## F5 — User docs + DX *(parallel from F1; finalized last)*

- **Getting-Started + tutorial:** install → write a `.mctest.yml` for *your* plugin → run → read the
  report. The current `/docs` are *design* docs; add *user* docs (authoring guide, selector cookbook,
  troubleshooting).
- **CLI ergonomics:** `mc-test init` (scaffold `mc-test.yml` + a sample test — note: only
  `mc-test.example.yml` exists today, no `mc-test.yml`); a richer `doctor` (Java, ports, downloads, Via;
  display/loader-toolchain checks deferred with mods); clear error messages.
- **Reporting:** an HTML report (skip matrix + per-test timeline); JUnit stays the CI contract.
  *(Screenshot gallery deferred — no rendered client in v1.0.)*
- **Authoring surface:** confirm fluent-API ↔ YAML parity; add step verbs only as real tests demand.
- **One real-world-style plugin example** beyond `regions`.

**Acceptance:** an external dev, given only `/docs`, installs and runs the regions test on Paper without
help.

---

## Definition of done (v1.0)

1. **CI green on every push** (TS + Java + conformance + import-scan) **and** a real-boot E2E lane. — ✅
   fast-lane green on `main` (PR #2); real-boot E2E lane nightly/dispatch.
2. The canonical regions test is **real-green including `assertPluginState`** on Paper, with the
   truth/UI-divergence and honest-skip negative controls enforced in CI.
3. The plugin product is runnable via **`npx mc-test`** *and* **`./gradlew mcTest` from IntelliJ**, with a
   `LICENSE` + Getting-Started docs.
4. The headless driver + `server-bukkit` agent are **green against the M1 conformance fixtures** for every
   method they advertise.
5. **No false greens:** every "can't run here" path is an honest skip or a loud failure, surfaced in the
   skip matrix.
6. **Docs match the shipped product** (Prime Directive 5) — no design-doc/implementation drift.
7. **Release gate:** make the OSS-vs-internal call → publish (npm + agent jars) or keep private.
   **Decided 2026-06-16: keep private** for v1.0 (root `private: true`; no publish). Reversible; revisit for v2.

## Practical prerequisites

- **Real boots need a real host.** Per the M3/M4/M5 status notes in `ROADMAP.md`, everything past the M2
  headless path is currently only *mock-green*. F1 and F6 acceptance require **Java (JDK 21) + network +
  a host that can actually boot Paper** — a developer machine or a capable CI runner, **not** an offline
  sandbox. No real-boot acceptance box is ticked without a genuine pass/fail JUnit + artifacts.
- **No Gradle wrapper is committed yet.** Until one is added (`gradle wrapper`), CI provisions a pinned
  Gradle via `gradle/actions/setup-gradle`, and `./gradlew` (F6) requires committing the wrapper.
