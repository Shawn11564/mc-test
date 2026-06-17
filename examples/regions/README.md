# examples/regions — the canonical SUT, built for every target

`OpenRegions` is the canonical "regions" system-under-test (SUT). It is **one behavior** authored
**once** as a test and run across the whole loader matrix — exactly the framework's "author once, run
everywhere, validate from real state" promise. The same `OpenRegions` feature is built in **four forms**,
one per target, so every driver path has a real example to drive.

## The behavior (identical across all forms)

`/or` opens an **OpenRegions** menu with a **Regions** button → a **Regions** list:

- entries seeded with `TestRegion`, `Spawn`, `Market` — click one to **load** it
  (marks it *active* + prints `Region loaded: <name>`),
- **Create** — add a region (`Region created: <name>`); the client mods type the name into a text field,
  the chest-menu plugin adds a fixed `Sanctuary` (a chest GUI can't host a text box),
- **Delete** — remove the active region (`Region deleted: <name>`).

Queryable runtime state (read over MCTP via `truth.assertPluginState`): `regions.exists{name}`,
`regions.count`, `regions.list`, `regions.active`.

## The four SUT forms

| Path | Target | Toolchain | Built artifact | Driven by |
|------|--------|-----------|----------------|-----------|
| [`plugin/`](plugin) | Bukkit/Paper plugin (server, chest GUI) | Maven | `regions-plugin.jar` | headless bot (+ `server-bukkit`) |
| [`mod-fabric/`](mod-fabric) | Fabric client mod (client `Screen`) | Loom, MC 1.21.1 | `openregions-fabric.jar` | in-process `client-fabric` |
| [`mod-forge/`](mod-forge) | Forge client mod | ForgeGradle, MC 1.20.1 | `openregions-forge.jar` | in-process `client-forge` |
| [`mod-neoforge/`](mod-neoforge) | NeoForge client mod | NeoGradle, MC 1.21.1 | `openregions-neoforge.jar` | in-process `client-neoforge` |

`plugin-gradle/` is the same plugin built via the Gradle front door (it reuses `plugin/`'s sources).
The Fabric mod additionally exposes `TestIdHolder` testIds; the Forge/NeoForge mods are **plain mods with
zero mc-test coupling**, driven purely through the real UI — a nice demonstration that the framework can
drive a SUT that knows nothing about it.

## The two test files (one flow per surface)

| File | Surface | Requires | Selects by |
|------|---------|----------|------------|
| [`regions.mctest.yml`](regions.mctest.yml) | server chest GUI (headless) | `containerGui` | `label` |
| [`regions.clientgui.mctest.yml`](regions.clientgui.mctest.yml) | real client `Screen` (rendered) | `clientScreens`, `chat` | `label` + `role:input` |

[`regions.fluent.test.ts`](regions.fluent.test.ts) authors the headless test in the fluent API and asserts
it compiles to the **identical** `NormalizedTest` as the YAML. The client-GUI test selects by visible
label + the input's role, so the **single** file runs unchanged across Fabric/Forge/NeoForge.

## Two kinds of "truth" (why a green means real state)

A test asserts **chat** (the GUI surface) *and* **server state** (`assertPluginState`) — they are
independent on purpose:

- **action→truth (headless/plugin):** clicking in the server chest GUI *mutates* the authoritative
  `RegionStore`, so `regions.exists`/`count`/`active` reflect the real action — no fixture needed.
- **fixture/seed→truth (rendered/mods):** a client mod **cannot** author server state, so the rendered
  rows co-load the server-side [plugin](plugin) + the `server-bukkit` truth agent. The asserted region
  (`TestRegion`) is seeded by the plugin, so the truth half is honestly green and **independent** of the
  client GUI.

The **negative controls** (in `tests/e2e/`) are what make this honest: a *truth/UI-divergence* test makes
the GUI say "Region loaded" for a region the server never created → `assertPluginState` goes **RED** while
chat is green; the *capability-skip* control runs the client-GUI test on the headless driver → the whole
test honestly **SKIPS** (`unmet:[clientScreens]`), never a false green.

## Build + run

```bash
# headless plugin path (runs anywhere with Java + network):
mvn -B -f examples/regions/plugin/pom.xml package        # → regions-plugin.jar
npx mc-test run examples/regions/regions.mctest.yml --target paper-1.20.4

# rendered client paths (need a display + the loader toolchains — acceptance-only):
gradle -p agents :core:publishToMavenLocal               # the TestIdHolder marker (Fabric only)
(cd examples/regions/mod-fabric   && ./gradlew build)    # → openregions-fabric.jar
(cd examples/regions/mod-forge    && ./gradlew build)    # → openregions-forge.jar
(cd examples/regions/mod-neoforge && ./gradlew build)    # → openregions-neoforge.jar
npx mc-test run examples/regions/regions.clientgui.mctest.yml --target fabric-1.21-client
# forge/neoforge rendered boots are opt-in: MC_TEST_RENDERED_LOADERS=forge,neoforge
```

Built jars are git-ignored. The matrix (root [`mc-test.yml`](../../mc-test.yml)) points each target row at
its per-loader jar. The committed real-boot harnesses live in [`tests/e2e/`](../../tests/e2e): headless
(`run-real-boot.mjs`), rendered Fabric (`run-rendered-boot.mjs`), and the multi-loader fan-out
(`run-matrix-boot.mjs`).

### Running the rendered client OFF-SCREEN (no foreground window)

On Windows/macOS a native rendered Minecraft client opens a real window that grabs the mouse and can
stall its render loop when it loses focus — so run it under a **virtual display** instead. The repo ships
[`Dockerfile.rendered`](../../Dockerfile.rendered) (Xvfb + Mesa software GL); the client renders entirely
inside the container, so nothing touches your desktop and it can't be accidentally clicked or closed:

```bash
docker build -f Dockerfile.rendered -t mc-test/rendered:21 .
bash scripts/run-rendered-docker.sh          # off-screen rendered boot (Xvfb); host node_modules untouched
```

(On Linux you can skip Docker — `xvfb-run -a node tests/e2e/run-rendered-boot.mjs` uses the same virtual
display directly.)
