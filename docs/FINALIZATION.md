# mc-test — Finalization Plan (path to a working v1.0 product)

> Status: planning. `ROADMAP.md` (M1→M5) built the **architecture**; this document is the plan to turn
> it into a **finished, usable product**. The architecture is complete and tested, but most of it has
> only ever been proven with **no-boot mock agents** — the framework has genuinely driven only the
> Paper + headless-bot path against real Minecraft. Every phase below ends with a **real boot producing
> a real pass/fail**, closing the `ROADMAP.md` acceptance boxes that are currently unticked.

---

## 0. Where we actually are (verified state)

> **Updated 2026-06-16:** the F0→F5 finalization (the v1.0 plugin slice) is **implemented and merged to
> `main`** (PR #1, merge `4760b90`). The first GitHub CI run was red on two real steps (CLI `--help`,
> `gradle-plugin` validation); both are now **merged via PR #2 (`dc3d82e`)** and **fast-lane CI is green
> on `main`** (the real-boot E2E lane runs nightly/dispatch). The table below reflects the new state;
> see `V1_PLAN.md` §Status for the per-phase commits + what remains.

| Area | State | Evidence |
|------|-------|----------|
| M1 protocol (`@mc-test/protocol`) | **Done.** Types + JSON Schema + conformance fixtures, drift-gated; + a hand-maintained authoring schema for `.mctest.yml`. | 217 tests green; schema-sync gate; `schema/mctest-stepfile.schema.json`. |
| M2 runner + headless (Paper) | **Done & really runs.** Real Mineflayer bot vs Paper 1.20.4 → green JUnit + HTML report. | `mc-test-report/report.html`, `junit/results.xml`. |
| M3 server-bukkit (truth) | **Done — run for real (F1).** A real boot co-selects the agent jar; `assertPluginState` is green vs real `RegionStore`; honest-skip + truth/UI-divergence controls + fixtures verified. | `tests/e2e/run-real-boot.mjs` (5/5 + N=3); server.log `MCTP listening`/`Done`/`Tester joined`. |
| M4 client-fabric + inprocess | **Implemented (F3).** Jars **build** via Loom (`openregions.jar`, `agent-client-fabric.jar`); `driver-inprocess` has a **real launcher** (Mojang manifest + Fabric loader resolution → client jar/libraries/natives, `KnotClient` offline, client-log MCTP scrape) verified on a Windows/Java-21 box; `screen.screenshot` persists a real PNG + auto-capture-on-failure + informational baseline diff; honest-skip `unmet:[clientScreens]` verified. The **rendered GREEN** (live frame + GUI click) is **CI-gated** by the `e2e.yml` `fabric-rendered-client` lane, not observed on a GPU-less local box. | `packages/driver-inprocess/{ClientProvisioner,ClientLauncher,Display}.ts`; `tests/e2e/run-rendered-boot.mjs`; `.github/workflows/e2e.yml` (`fabric-rendered-client`); `Dockerfile.rendered`. |
| M5 fan-out (forge/neoforge/server-fabric + pixel) | **v2 (deferred).** Scaffolded; pixel stub throws; old-version rows honest-skip. | — |
| CI | **Green (F0).** `ci.yml` fast lane (TS + JVM gates) + `e2e.yml` (real-boot harness + `gradle mcTest`, nightly). First GitHub run was red on two steps (CLI `--help`, `gradle-plugin` validation) → **fixed + merged via PR #2 (`dc3d82e`)** (+ job timeouts); **fast-lane CI green on `main`** (real-boot E2E lane nightly/dispatch). | `.github/workflows/`. |
| Provisioning | **Paper, real + hardened.** `keepOnFailure` cleanup; honest old-version skip (`UNSUPPORTED_TARGET`); `via:true` honest-skip (`VIA_BRIDGE_UNAVAILABLE`); `sha256`-verified `path`/`url` sources. Non-Paper resolvers are v2. | `provision/sources.ts`, `cli.ts`, `PaperProvisioner.ts`. |
| Gradle/IntelliJ (F6) | **Done.** `gradle mcTest` builds the SUT jar, boots Paper, runs the test — verified end-to-end. | `gradle-plugin/`, `examples/regions/plugin-gradle/`. |
| Docs / DX (F5) | **Done.** `GETTING_STARTED.md` + `AUTHORING.md`; `mc-test init` / rich `doctor`; HTML report. | `docs/`. |
| Packaging | **Licensed, not yet published.** `LICENSE` = MIT; root still `private: true`; publish deferred to the D1 distribution decision. | `LICENSE`, `package.json`. |

**Usable now (v1.0):** testing **Spigot/Paper plugin GUIs** (chest/anvil/sign menus), chat, commands, **and
server-side truth** (`assertPluginState` / fixtures) on a **real Paper boot** — from the CLI or
`gradle mcTest`, with an HTML + JUnit report. The F0→F5 finalization is merged to `main` (PR #1); the CI
fixes are merged (PR #2, `dc3d82e` — fast-lane CI green on `main`) and the D1 distribution decision is
made (internal/private). See `V1_PLAN.md` §Status for the per-phase detail.

**Two scope decisions** that change the size of this plan — **✅ ratified 2026-06-16** (see `V1_PLAN.md`,
which is authoritative for the locked v1.0 order):
- **D1 — Public OSS vs internal tool? → DECIDE LATER.** Build the engineering now; defer the
  publish-vs-private call to a release gate at the end. F0 does CI + release *plumbing* + a `LICENSE` but
  does **not** publish publicly. (Keeps Phase 0 distribution-neutral.)
- **D2 — rendered-client + multi-loader matrix in v1.0, or Paper/plugin slice with mods as v2? →
  PAPER/PLUGIN SLICE.** Mods (rendered client + the loader matrix) were **v2**; phases F3–F4 (~70% of the
  remaining engineering) were deferred. **Update (2026-06-16): F3 (the rendered-client path / M4) is now
  implemented** — real `driver-inprocess` launcher + Loom-built `openregions.jar`/`agent-client-fabric.jar`
  + screenshot wiring, with the rendered green produced by the GL-capable `e2e.yml` `fabric-rendered-client`
  lane and the honest-skip verified (§5). **F4** (the multi-loader fan-out across forge/neoforge/server-fabric)
  remains the outstanding rendered-matrix work.
- **(Added) IDE front door → F6 IS IN v1.0.** `./gradlew mcTest` from IntelliJ is part of the first usable
  product for this JVM/IntelliJ shop.

**Locked v1.0 build order:** **F0 → F1 → F6 → F2(Via) → F5(docs)** — see `V1_PLAN.md`.

---

## 1. Phase map (build order at a glance)

| Phase | Theme | Depends on | Closes |
|-------|-------|-----------|--------|
| **F0** | **CI + release foundation** | — | the "nothing runs automatically / can't install it" gap |
| **F1** | **Make the Paper/plugin product real** | F0 | M2/M3 real-boot acceptance; the canonical regions truth assertion |
| **F2** | **Provisioning breadth + version spanning (Via)** | F1 | non-Paper servers; the `paper-1.8.9`/old-version rows |
| **F3** ✅ | **Rendered-client path for real** *(implemented; rendered green CI-gated)* | F0 (F2 for a Fabric server) | M4 real-boot acceptance; "test real mod GUIs" |
| **F4** | **Multi-loader fan-out for real** | F2, F3 | M5 real-boot acceptance; the full matrix |
| **F5** | **Productization & DX** | F1 | "a new user can install, author, and run from docs alone" |
| **F6** | **IntelliJ / Gradle integration (JVM-dev front door)** | F0, F1 | the "not IDE-native / hard to set up for a JVM dev" gap |
| **F7** | **Robustness, scale, optional** | F1–F4 | nightly matrix under budget; equivalence harness; pixel (optional) |

> **Minimum shippable v1.0 (plugin product):** F0 + F1 (+ F2 Via for old versions) + the F5 docs slice.
> **For a JVM/IntelliJ plugin team specifically:** add **F6** (the Gradle/IDE front door) so tests run via
> `./gradlew mcTest` from the editor — for that audience it is part of the minimum, not a nicety.
> **Full "author once, run the matrix" promise:** **F3 is now implemented** (rendered Fabric client:
> real launcher + Loom-built jars + screenshot; rendered green CI-gated via `e2e.yml`
> `fabric-rendered-client`), so the remaining engineering is **F4** — the multi-loader fan-out
> (Loom/ForgeGradle/NeoGradle + per-version mappings for forge/neoforge/server-fabric), exactly what
> M5 flagged as "acceptance-only." (GL/Xvfb headless rendering, the M4 hard part, is addressed by F3's
> pinned Mesa/llvmpipe image + the `fabric-rendered-client` lane — CI-gated, not yet observed locally.)

---

## 2. F0 — CI + release foundation  *(small; do first — everything else needs it)*

**Goal:** every push is gated by the suites that are already green, real boots run on a capable runner,
and the packages/jars are installable.

- [ ] **GitHub Actions (fast lane, hosted runner):** `npm ci` → `npm test --workspaces` + `npm run typecheck --workspaces` + the protocol schema-sync gate; `gradle :core:test :server-bukkit:test`. (All green today — this just enforces it.)
- [ ] **Import-scan + conformance as hard gates** (CLAUDE.md Prime Directives): the mappings-quarantine scan (`m5.test.ts`) and the M1 conformance replays must fail CI on regression.
- [ ] **Real-boot lane (Java runner):** boot Paper, run the canonical regions test, assert green JUnit + attach artifacts. Marks the framework "actually works" in CI, not just locally.
- [ ] **Artifacts:** upload JUnit + server/client logs (+ screenshots — F3 landed: `screen.screenshot` persists a real PNG, auto-captured on failure) per run; surface via a test-reporter action.
- [ ] **Release plumbing:** flip root `private`, decide publish strategy for `@mc-test/*` (npm, with provenance) and the **agent jars** (GitHub Releases, named `agent-<variant>-<mc>.jar` per CLAUDE.md). Add `LICENSE` (resolve README "TBD"). Tag a `0.1.0` pre-release.
- [ ] **Version/compat policy:** document the MCTP `protocolVersion` bump rules (already in PROTOCOL.md §15) as the release contract.

**Acceptance:** green CI badge on `main`; a tagged pre-release; `npx mc-test --help` works from a clean checkout following the README.

**Risk/notes:** the real-boot lane needs Java + network (Paper download) — use a self-hosted or larger hosted runner. Keep the fast lane hosted+free so PRs stay quick.

---

## 3. F1 — Make the Paper/plugin product real  *(small–medium; highest value)*

**Goal:** the canonical regions story passes **including server truth** on a real boot — assert the region
*actually exists server-side*, not just that chat said so.

- [ ] **Co-select the bukkit agent in a real boot:** build `mc-test-agent-bukkit.jar`, drop it into `plugins/` on its second MCTP port (provisioner code already exists), run `--target paper-1.20.4`, and confirm `assertPluginState regions.exists{TestRegion}` goes **green** against real server state.
- [ ] **Wire the M3 negative controls into CI (§7.3):** the **truth/UI-divergence** control (GUI says "loaded" but the fixture creates no region → `assertPluginState` red) and the **honest skip** (no agent → `unmet:[pluginState]`). These are the single most important "the tester doesn't lie" checks.
- [ ] **Fixtures + fake players for real:** exercise `fixture.set/reset` (deterministic region setup) and `player.spawnFake` (Carpet) on a real Paper(+Carpet) boot; confirm world-snapshot reset leaves pristine state.
- [ ] **Harden the provisioner:** robust EULA/`server.properties` forcing, port leasing under concurrency, ordered teardown, `keepOnFailure` artifact retention, boot-timeout/readiness probes (no fixed sleeps).
- [ ] **Flake budget:** run the Paper E2E **N=3 nightly**; trip an alarm on nondeterminism (ROADMAP §7.4).
- [ ] **Tick ROADMAP §4.5 / §9 real-boot boxes** as each lands.

**Acceptance:** `npx mc-test run examples/regions/regions.mctest.yml --target paper-1.20.4` on a clean machine → green **including** `assertPluginState`; the two negative controls behave as designed in CI.

**Risk/notes:** Carpet/fake-player and some fixtures need the right server build; gate per-capability and honest-skip where a backend is absent. This phase is mostly *wiring + a CI job* — the engine already works.

---

## 4. F2 — Provisioning breadth + version spanning  *(medium)*

**Goal:** boot more than Paper, and make old-version testing real via ViaProxy.

- [ ] **Source resolvers (ENVIRONMENTS.md §2.3):** Mojang vanilla (version manifest), Fabric installer (`server` mode), Forge/NeoForge installers. Today only `paper:` resolves.
- [ ] **ViaProxy front for headless:** make `via: true` real — stand up ViaProxy in front of the server so modern Mineflayer can speak old protocols; prove `paper-1.8.9`, or **honest-skip with a precise reason** if Via can't faithfully bridge a feature (never a dubious pass).
- [ ] **Pin** Via/Mineflayer/minecraft-data per target so old-version behavior is reproducible; treat a Via bump as a matrix change gated by the golden E2E.
- [ ] **Modrinth/URL/sha256 source verification** for third-party plugin/mod deps (schema already documented).

**Acceptance:** `paper-1.8.9` runs (or honest-skips with a reason in the skip matrix); a Fabric/NeoForge **server** boots successfully (prereq for the server-fabric agent in F4).

**Risk/notes:** very old protocols + quirky GUIs are the classic pain (ROADMAP §8.4) — lean on the skip matrix to make coverage gaps visible rather than faking passes.

---

## 5. F3 — Rendered-client path for real (finish M4)  *(implemented; rendered green CI-gated)*

**Goal:** drive a **real, client-rendered mod Screen** — the one thing the bot fundamentally cannot see.

> **Status (2026-06-16): IMPLEMENTED.** The "never built / never launched" M4 gap is closed: the Fabric
> jars **build via Loom 1.7.4** (Gradle 8.10.2, JDK 21), `/packages/driver-inprocess` has a **real
> launcher** (no longer a fictional CLI), the screenshot path is wired + unit-tested, and the
> **honest-skip** half is **verified for real**. The one piece **not observed on this GPU-less local
> machine** is the actual **rendered GREEN** (a live frame + the GUI click on a running client); that
> green is **implemented and CI-gated** by the `e2e.yml` **`fabric-rendered-client`** lane / a desktop
> runner. Boxes below are checked on that basis; the rendered-green box is left honest.

- [x] **Build the SUT + agent (Loom):** the regions **mod** (`examples/regions/mod`) → **`openregions.jar`** and the **client-fabric** agent → **`agent-client-fabric.jar`** (shaded `/agents/core` + Java-WebSocket as jar-in-jar) **now build** (Loom 1.7.4 / Gradle 8.10.2 / JDK 21). Per-version Yarn fixes were confined to `agents/client-fabric/.../mappings/Names.java` (`ConnectScreen` → `net.minecraft.client.gui.screen.multiplayer` at 1.20.4+; `NativeImage.writeTo(OutputStream)` round-trips through a temp `Path`); the mappings import-scan gate still passes.
- [x] **ClientLauncher real launch:** `driver-inprocess` offline auth, mod injection, and the `MCTP listening on :PORT` scrape are real. `ClientProvisioner.ts` resolves the Mojang manifest → client jar + libraries + (optional) assets + the Fabric loader profile → loader libraries, extracts LWJGL natives, and stages the per-instance `mods/` from a content-addressed cache; `ClientLauncher.ts` builds a real `java -Djava.library.path=<natives> -cp <all jars> net.fabricmc.loader.impl.launch.knot.KnotClient` offline command (username `Tester`, zero UUID, `--accessToken 0`). **Verified on a real Windows/Java-21 box**: resolved MC 1.21.1, Fabric loader 0.19.3, downloaded the client jar + 54 libraries, extracted 8 LWJGL native bundles, staged the two jars, built a real 55-jar-classpath `KnotClient` command.
- [x] **Headless rendering (ROADMAP §8.2):** `Display.ts` auto-selects Xvfb (Linux CI, `LIBGL_ALWAYS_SOFTWARE=1`) vs. desktop and runs a real `startDisplay` lifecycle (reuse ambient `DISPLAY`, else spawn a managed Xvfb learned via `-displayfd`); `Dockerfile.rendered` pins `eclipse-temurin:21-jdk` + Node 22 + Xvfb + Mesa/llvmpipe. *(The Xvfb selection + launch construction are unit-tested + verified locally; launching a **real client into Xvfb under Mesa** runs in the `fabric-rendered-client` CI lane.)*
- [ ] **Drive the Screen:** `waitForScreen` / `click` / `typeText` / `pressKey` / `screenshot` against the real `Screen`/widget tree. *(**CI-gated, not observed locally** — needs the live `Screen`/widget tree + framebuffer + a running server; produced by the `e2e.yml` `fabric-rendered-client` lane / a desktop runner. The screenshot **wiring** below is done; the baseline diff is wired informational/non-gating into the HTML + JUnit reports.)*
- [x] **Screenshot wiring:** the `screen.screenshot`/screenshot step persists a **real PNG artifact**, the runner **auto-captures a screenshot on test failure** when the driver advertises `screenshot` (defensive, never crashes), and a dependency-free PNG **baseline diff** is wired **informational, non-gating** into the HTML + JUnit reports.
- [x] **Combined session:** client GUI proves the click **and** the bukkit agent proves the region — one test, two connections (proven no-boot by the runner M4 combined-session test; the `mc-test.yml` fabric/neoforge client rows were corrected to co-select **`server-bukkit`** + the regions plugin since the server is Paper, ROADMAP §5.4 / ENVIRONMENTS §2.4.2).
- [x] **Capability-driven mixed suite:** `clientScreens` tests pick `inprocess`; `containerGui`-only still pick headless; same `mc-test.yml` (proven no-boot by the runner M4 tests).
- [x] **Tick ROADMAP §5.4 real-boot boxes** (the screenshot-wiring and `Display.ts` auto-select boxes ticked; the end-to-end rendered box annotated split — honest-skip verified, rendered-green CI-gated).

**E2E/CI:** `tests/e2e/run-rendered-boot.mjs` (positive rendered run + honest-skip-on-headless + screenshot artifact) runs in the `fabric-rendered-client` job in `.github/workflows/e2e.yml` (installs `xvfb` + `libgl1-mesa-dri` + `mesa-utils`, Loom-builds the jars, runs under `xvfb-run`); `Dockerfile.rendered` is the pinned headless-rendering image.

**Acceptance:** the client-GUI regions test **honest-skips on headless** (`unmet:[clientScreens]`) — **VERIFIED** (JUnit `<skipped message="NO_COMPATIBLE_DRIVER unmet:[clientScreens] — …"/>`, exit 0); and is **green on a rendered client** — **implemented + CI-gated** via `fabric-rendered-client`, **not observed on this GPU-less local box**. A screenshot artifact is attached on failure (wiring done).

**Risk/notes:** GL context + obfuscation mappings + first-frame startup timing are the hard parts (GL addressed by the pinned Mesa/llvmpipe image + the `fabric-rendered-client` lane — CI-gated, not yet observed locally; mappings quarantined to `Names.java`). Selectors use the widget tree (not pixels), so a flaky framebuffer only affects the (informational) screenshot, not logic.

---

## 6. F4 — Multi-loader fan-out for real (finish M5)  *(large)*

**Goal:** the same test runs across the whole `(loader × version)` matrix from one unchanged file.

- [ ] **Build the loader shims:** `client-forge` (ForgeGradle), `client-neoforge` (NeoGradle), `server-fabric` (Loom). They have **never been compiled** — expect per-version `Names.java` mapping drift to fix (this is the per-version tax the one-file quarantine isolates).
- [ ] **server-fabric truth for real:** real GameTest/server hooks + the `ServiceLoader` SPI discovery against a booted Fabric/NeoForge server; `assertPluginState`/fixtures/fake-players green there.
- [ ] **Run the full matrix:** paper (headless), `paper-1.8.9` (via), fabric/forge/neoforge (inprocess) — each green or honest-skip — emitting the **real** aggregated JUnit + the `(test × target)` skip matrix.
- [ ] **Per-target parallelism:** bounded-concurrency run loop in the CLI (today it's sequential; isolation via distinct ports + per-test world copies already makes it parallel-safe).
- [ ] **Prove "add a version = one `Names.java` + a yml row"** with a real PR touching no shared core file.
- [ ] **Tick ROADMAP §6.3 real-boot boxes.**

**Acceptance:** `mc-test run … --target all` boots the matrix and produces one JUnit + a skip matrix with real green/red/skip cells.

---

## 7. F5 — Productization & developer experience  *(medium; parallelizable with F2–F4)*

**Goal:** a new user can install, author a test, and run it across targets using the docs alone.

- [ ] **Getting-Started + tutorial:** install → write a `.mctest.yml` for your plugin → run → read the report. The current `/docs` are *design* docs; add *user* docs (authoring guide, selector cookbook, troubleshooting, the matrix file).
- [ ] **CLI ergonomics:** `mc-test init` (scaffold `mc-test.yml` + a sample test); a richer `doctor` (checks Java, ports, downloads, display backend, Via, loader toolchains); clear error messages.
- [ ] **Reporting:** an HTML report (skip matrix + per-test timeline + screenshot gallery); optional video-on-failure; keep JUnit as the CI contract.
- [ ] **Authoring surface:** confirm fluent-API ↔ YAML parity; add step verbs only as real tests demand them (stay minimal).
- [ ] **Real-world examples** beyond `regions`: a genuine third-party-style plugin GUI test and a mod GUI test.

**Acceptance:** an external dev, given only `/docs`, installs and runs the regions test across ≥2 targets without help.

---

## 8. F6 — IntelliJ / Gradle integration (the JVM-dev front door)  *(small–medium; high value for plugin/mod teams)*

**Goal:** make mc-test a first-class IntelliJ citizen for a Java/Kotlin plugin/mod project: `./gradlew
mcTest` builds the SUT jar and runs co-located tests against an **ephemeral, mc-test-owned** instance,
with editor autocomplete and a fast inner loop — **local == CI**. The Node engine stays the single source
of truth; this is a thin JVM front door over it (don't reimplement the runner on the JVM).

- [ ] **Gradle plugin (`mc-test-gradle`):** applied in the plugin/mod project; registers a `mcTest` task
      (+ per-target `mcTest<Target>` variants) that **`dependsOn` the SUT jar task** (`jar` / `shadowJar` /
      `remapJar`) so a run always tests the freshest build, then invokes the runner against an ephemeral
      instance. Surfaces natively in IntelliJ's Gradle tool window (gutter ▶, auto-generated run configs).
- [ ] **Node bootstrap:** the plugin provisions a pinned Node + the `@mc-test/runner` package (via a Gradle
      Node plugin / toolchain) so a JVM dev never installs Node/npm by hand. *(Prefers F0's published
      package; until then, vendor a tarball.)*
- [ ] **Config surface:** a small `mcTest { … }` Gradle extension (targets, test dir, report dir) **or**
      auto-discovery of a project `mc-test.yml` + a co-located test dir (e.g. `src/mctest/`). The SUT jar
      path is wired from the build graph, **never hand-edited**.
- [ ] **Co-located tests + step-file JSON Schema:** convention for tests living in the SUT repo (versioned
      with the code). Ship a **JSON Schema for the `.mctest.yml` step-file format** and register it
      (IntelliJ YAML schema mapping / `yaml-language-server`) so the editor gives **autocomplete +
      validation** while authoring. *(mc-test ships wire/method schemas today but no authoring schema.)*
- [ ] **SPI scaffolding:** document + scaffold `McTestStateProvider` / `McTestFixtureProvider` registration
      (Java **or** Kotlin) so `assertPluginState`/fixtures resolve against real state; optionally a tiny
      `compileOnly` helper artifact so the SUT compiles against the SPI without pulling the whole agent.
- [ ] **Warm / watch dev mode:** a `mcTestWatch` mode that keeps one instance up, **redeploys the rebuilt
      jar**, and reruns the changed test for a fast inner loop (today the engine cold-boots each run; the
      server jar download is cached but the boot is not reused). Hermetic ephemeral stays the default + CI
      path.
- [ ] **CI wiring:** `mcTest` participates in `./gradlew check`; JUnit XML lands where IntelliJ / CI
      reporters expect it, alongside the skip matrix.
- [ ] *(stretch)* **JUnit 5 `TestEngine`:** surface each `(test × target)` cell in IntelliJ's green/red
      test tree (run / rerun-failed natively) — the IDE-native ceiling; bigger lift.
- [ ] *(optional)* **Kotlin/Java authoring DSL** that serializes to the canonical test spec — native-language
      authoring without breaking the narrow waist (the wire + engine stay TS).

**Acceptance:** in a sample Paper plugin project, applying the Gradle plugin + writing a co-located
`.mctest.yml` lets a dev run `./gradlew mcTest` (or click ▶ in IntelliJ) → it builds the jar, boots an
ephemeral server, runs the test, and shows JUnit results — with editor autocomplete on the step file and
**no manual Node setup**.

**Depends on:** F0 (published engine) ideally; F1 (so plugin-state assertions are trustworthy when run via
Gradle). **Can start right after F1** for a JVM-focused rollout — parallel with F2/F5.

**Risk/notes:** mods need F3/F4 before the `inprocess` targets run, but the *integration* is
loader-agnostic — the same Gradle plugin serves plugins now and mods once those land. Resist
reimplementing the engine on the JVM; the value is one cross-language runner behind a thin front door.

---

## 9. F7 — Robustness, scale, and optional bets  *(ongoing)*

- [ ] **Cross-driver equivalence harness (ROADMAP §7.4):** where a test is expressible on both bot and client, run both and assert the *same* semantic outcome; divergence = a driver bug.
- [ ] **Pixel/OCR backend (optional):** implement capture + OCR (Tesseract) + template (OpenCV) + OS input (nut-js), or formally defer and keep it a documented selectable stub. **Decision required.**
- [ ] **Hermetic CI at scale:** Testcontainers/Docker provisioning; matrix sharding; boot/world-snapshot caching + warm pools to keep the nightly matrix under a time budget.
- [ ] **Security/isolation pass:** confirm `online-mode=false` + loopback-only + per-test world copies hold under parallelism; sandbox the rendered client.
- [ ] **Observability:** timing breadcrumbs (`event.log`) for flake triage; structured run metadata.

**Acceptance:** the full matrix runs nightly in CI within budget with a flake alarm; documented security posture.

---

## 10. Definition of done (v1.0)

1. **CI green on every push** (TS + Java + conformance + import-scan) and a **real-boot E2E** lane. — ✅
   fast-lane green on `main` (PR #2, `dc3d82e`); real-boot E2E lane nightly/dispatch.
2. **The canonical regions test is real-green** including `assertPluginState` on Paper, with the truth/UI-divergence and honest-skip negative controls enforced in CI.
3. **At least the plugin product is installable** (`npx mc-test`, and — for JVM teams — runnable via `./gradlew mcTest` from IntelliJ), licensed, with Getting-Started docs — *or*, if D2 includes mods, the full matrix (headless + inprocess + server agents) runs green-or-honest-skip end-to-end.
4. **Every shipped driver/agent is green against the M1 conformance fixtures** for the methods it advertises.
5. **No false greens:** every "can't run here" path is an honest skip or a loud failure (incl. the pixel stub and any unbuilt loader agent), surfaced in the skip matrix.
6. **Docs match the shipped product** (Prime Directive 5) — no design-doc/implementation drift.

---

## 11. Sequencing & effort (rough)

| Phase | Size | Can start |
|-------|------|-----------|
| F0 CI + release | S | now |
| F1 Paper/plugin real | S–M | after F0 |
| F2 provisioning + Via | M | after F1 |
| F3 rendered client | L | after F0 (needs F2 for a Fabric server target) |
| F4 multi-loader | L | after F2 + F3 |
| F5 product/DX | M | alongside F1+ |
| F6 IntelliJ/Gradle integration | S–M | after F1 (parallel F2/F5) |
| F7 robustness/optional | ongoing | after F1–F4 |

**Recommended first slice (ships a real product fastest):** **F0 → F1 → F2(Via) → F5(docs)** = a genuinely
usable, CI-gated **Paper/Spigot plugin testing** product. **For a JVM/IntelliJ shop, insert F6 right after
F1** (**F0 → F1 → F6 → F2 → F5**) so it lands as `./gradlew mcTest` in the editor. Then take on **F3 → F4**
for the rendered-client and full-matrix promise.

> All wire names, capability keys, selector keys, error codes, `mc-test.yml` fields, and milestones in this
> plan are defined canonically in `PROTOCOL.md` / `ENVIRONMENTS.md` / `ROADMAP.md`; this document defers to
> them and is authoritative only for the **finalization order and its acceptance criteria**.
