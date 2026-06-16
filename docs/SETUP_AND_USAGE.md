# Setup & Usage

A single-page guide: from a clean checkout to running tests on a real Paper server, via the
**CLI** or **`./gradlew mcTest`**, plus a condensed authoring reference. For the narrated
walkthrough see [`GETTING_STARTED.md`](./GETTING_STARTED.md); for the full step/verb/selector
reference see [`AUTHORING.md`](./AUTHORING.md); for the matrix schema see
[`ENVIRONMENTS.md`](./ENVIRONMENTS.md). This doc defers to those for canonical detail.

> **Scope (v1.0):** the **Paper/Spigot plugin** path is real and CI-gated. Rendered-client
> **mod** GUIs and the full multi-loader matrix are v2 — those targets honestly *skip* (never a
> false green). mc-test is **private/internal for v1.0** (not published to npm), so you build
> from the checkout.
>
> Commands use POSIX style (`./gradlew`, forward slashes). On Windows PowerShell use
> `.\gradlew` and `npx mc-test …` works the same.

## 1. Prerequisites

| Need | Why |
|---|---|
| **Node.js 18+** | the runner/engine (TypeScript) |
| **JDK 17+ (21 recommended)** | boots the Minecraft server — `java -version` |
| **Gradle 9.4.0** *(or the committed `./gradlew`)* | JVM agents + the Gradle front door |
| **Maven** | builds the bundled example plugin — `mvn -version` |
| **Network** | downloads the Paper jar once (cached in `~/.mc-test/cache`) |

Run `npx mc-test doctor` any time to check Java, ports, downloads, and the matrix.

## 2. Build the framework (one time)

```bash
git clone <repo> mc-test && cd mc-test
npm install
npm run build      # builds @mc-test/protocol → drivers → runner, in dependency order
```

This produces the CLI at `packages/runner/dist/cli.js` (the `mc-test` bin inside the workspace).

## 3. Run the canonical regions test (real Paper boot)

Build the example System-Under-Test plugin (`OpenRegions`) and the server-truth agent once:

```bash
# the server-truth agent (assertPluginState / fixtures) + its SPI → local Maven repo
gradle -p agents :core:publishToMavenLocal :server-bukkit:jar
# the example plugin jar (the SUT)
mvn -f examples/regions/plugin/pom.xml package
```

Then run it:

```bash
npx mc-test run examples/regions/regions.mctest.yml --target paper-1.20.4
```

The bot joins, runs `/or`, clicks **Regions → TestRegion**, matches the chat line, and — because
`paper-1.20.4` co-selects the `server-bukkit` agent — asserts the region **actually exists in
server state**:

```
✓ regions-open-testregion [paper-1.20.4] — PASSED
  ✓ join · ✓ command · ✓ waitForScreen · ✓ click · ✓ click · ✓ assertChat
  ✓ assertPluginState: pluginState regions.exists = true
```

### CLI commands

```
mc-test run <stepfile.mctest.yml> [more...]    run test(s) against the matrix
        [--target <id>|<id,id,...>|all] [--matrix mc-test.yml]
        [--plugin built-sut.jar] [--out dir] [--fail-on-skip]
mc-test list                                   list targets in the matrix [--matrix mc-test.yml]
mc-test doctor                                 check Java, ports, downloads, matrix
mc-test init                                   scaffold mc-test.yml + a sample test [--dir <dir>]
mc-test --help                                 usage
```

`--target all` (or no `--target`) runs every row and aggregates into one JUnit + a skip matrix.
Multiple step files run as `(test × target)`.

## 4. Read the report

Everything lands under `./mc-test-report/`:

- **`report.html`** — run totals, the `(test × target)` skip matrix, a per-test step timeline.
- **`junit/results.xml`** — the machine/CI contract; skips appear as `<skipped>` with a reason.
- On failure: an artifacts bundle under `mc-test-report/artifacts/<target>/<test>/` (server log + step trace).

## 5. Gradle / IntelliJ front door (`./gradlew mcTest`)

The JVM-native path — no manual jar paths, runnable from IntelliJ's Gradle tool window. The
plugin builds the SUT jar, boots an **ephemeral, mc-test-owned** server, runs your `.mctest.yml`
tests, and writes JUnit. It is a thin front door over the Node runner (the engine stays the
single source of truth).

**Try it on the bundled sample** (a Gradle wrapper is committed, so this works without a system Gradle):

```bash
# publish the agent core + the front-door plugin to mavenLocal first
gradle -p agents :core:publishToMavenLocal :server-bukkit:jar
gradle -p gradle-plugin publishToMavenLocal

cd examples/regions/plugin-gradle
./gradlew mcTest             # builds the jar → boots Paper → runs the regions test
```

**Apply it to your own plugin project:**

```kotlin
// settings.gradle.kts
pluginManagement { repositories { mavenLocal(); gradlePluginPortal() } }

// build.gradle.kts
plugins {
    java
    id("io.mctest.mc-test") version "0.1.0"
}

mcTest {                                     // all optional — these are the defaults
    matrix.set(file("mc-test.yml"))          // mc-test.yml at the project root
    tests.from("src/mctest")                 // src/mctest/**/*.mctest.yml
    targets.set(listOf("paper-1.20.4"))      // empty → the whole matrix
    sutJarTask.set("jar")                    // "shadowJar" / "remapJar" for fat / mod jars
    // runnerCli.set(file("…/packages/runner/dist/cli.js"))  // point at this monorepo's CLI (engine unpublished)
    addSpiDependency.set(true)               // auto compileOnly the agent-core SPI
    wireIntoCheck.set(false)                 // make `check` depend on mcTest
}
```

The SUT jar is wired from the build graph (`mcTest` `dependsOn` the jar task and passes its output
via `--plugin`), so **`mc-test.yml` never hand-references a jar path**. In IntelliJ: Gradle tool
window → **verification → mcTest** (gutter ▶). One task per target is generated too
(e.g. `mcTestPaper1204`).

> Because the engine isn't published yet (v1.0 is private), set `runnerCli` to this repo's
> `packages/runner/dist/cli.js`, or keep your plugin project inside the monorepo so the runner
> auto-resolves (`node_modules/@mc-test/runner` or the monorepo build).

### Server-truth SPI

To make `assertPluginState` / fixtures resolve against real plugin state, register the SPIs
(shipped in `io.mctest:mc-test-agent-core`, added as `compileOnly` automatically):

```java
getServer().getServicesManager().register(
    McTestStateProvider.class, new MyStateProvider(), this, ServicePriority.Normal);
getServer().getServicesManager().register(
    McTestFixtureProvider.class, new MyFixtureProvider(), this, ServicePriority.Normal);
```

See `examples/regions/plugin` (`RegionsStateProvider` / `RegionsFixtureProvider`) for a complete example.

## 6. Scaffold tests for your own plugin

```bash
npx mc-test init      # writes mc-test.yml + src/mctest/example.mctest.yml (never overwrites)
```

Then: (1) point `plugins[].path` at your built jar (CLI path), or rely on the Gradle plugin to
inject it; (2) write your steps (§8); (3) `npx mc-test run src/mctest/example.mctest.yml --target paper-1.20.4`.

## 7. The matrix — `mc-test.yml`

```yaml
version: 1
provision:
  eulaAccepted: true        # you accept Mojang's EULA by setting this (required to boot)
  bindHost: 127.0.0.1       # loopback only
  portRange: [25700, 25899]
  cacheDir: ~/.mc-test/cache
targets:
  - id: paper-1.20.4
    loader: paper
    mc: "1.20.4"
    driver: headless
    server: { paper: { build: latest } }
    plugins:
      - { path: ./build/libs/your-plugin.jar }   # your SUT jar (omit when the Gradle plugin injects it)
    agents: [server-bukkit]                       # co-select for assertPluginState / fixtures
```

See [`ENVIRONMENTS.md`](./ENVIRONMENTS.md) for the full schema (worlds/snapshots, server-property
forcing, source resolvers).

## 8. Authoring reference — `.mctest.yml`

```yaml
# yaml-language-server: $schema=<path>/packages/protocol/schema/mctest-stepfile.schema.json
name: my-test
requires: { command: true, containerGui: true }   # whole test SKIPS if unmet (never a false pass)
steps:
  - join: { username: Tester }
  - command: "or"                       # runs /or (no leading slash)
  - waitForScreen: { titleContains: "My GUI" }
  - click: { label: "Some Button" }
  - assertChat: { contains: "expected" }
  - assertPluginState:
      requires: { pluginState: true }   # per-step gate → only this step skips if unavailable
      plugin: "MyPlugin"
      query: "my.query"
      args: { name: "X" }
      expect: true                      # REQUIRED (bare value = equals; or { gt, gte, lt, lte, contains, exists, … })
```

**Step verbs:** `join`, `leave`, `chat`, `command`, `waitForChat`/`assertChat`, `waitForScreen`,
`listElements`, `click`, `type`, `press`, `screenshot`, `getBlock`, `getEntities`,
`assertPluginState`, `fixture`, `spawnFakePlayer`.

**Selectors** (semantic — never slot indices/pixels; present keys are ANDed): `label`/`text`,
`textContains`, `loreContains`, `itemType`, `role`, `index`/`nth`, `within`, `testId`. Shorthand:
`click: "Regions"` ≡ `click: { label: "Regions" }`; `click: "#save"` ≡ `{ testId: "save" }`.

**Capabilities** (drive honest skips): the headless bot advertises
`chat/command/containerGui/typeText/pressKey`; `server-bukkit` adds
`worldTruth/pluginState/fixtures/chat/testIdTags` (`fakePlayers` only with a Carpet backend). Gate
GUI assertions behind `containerGui`, server-truth behind `pluginState` — the same file
runs-or-honestly-skips across the matrix.

There is also a TypeScript **fluent API** (`import { test } from "@mc-test/runner"`) with 1:1 parity
to the YAML — see [`AUTHORING.md`](./AUTHORING.md).

**Editor autocomplete:** add a `# yaml-language-server: $schema=…` modeline pointing at
`packages/protocol/schema/mctest-stepfile.schema.json`, or in IntelliJ map `*.mctest.yml` to that
schema (Settings → JSON Schema Mappings).

## 9. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `npx mc-test` → no output / not found | Run `npm run build` first (the CLI is built to `dist/`). |
| `EULA_NOT_ACCEPTED` | Set `provision.eulaAccepted: true` in `mc-test.yml`. |
| `assertPluginState … SKIPPED unmet=[pluginState]` | Add `agents: [server-bukkit]` to the target (and build it: `gradle -p agents :server-bukkit:jar`). |
| `agent jar not found` | `gradle -p agents :server-bukkit:jar`, or drop `agents:` (truth steps then honestly skip). |
| `plugin not found … build the SUT first` | Build your plugin jar and point `plugins[].path` at it. |
| `UNSUPPORTED_TARGET` / `VIA_BRIDGE_UNAVAILABLE` | Expected in v1.0 — legacy versions (e.g. 1.8.x) + ViaProxy bridging are v2; the cell honestly skips. |
| First boot is slow | The Paper jar downloads once into `~/.mc-test/cache`; later runs reuse it. |

## See also

- [`GETTING_STARTED.md`](./GETTING_STARTED.md) — narrated first-run walkthrough.
- [`AUTHORING.md`](./AUTHORING.md) — full verb / selector / capability reference + fluent API.
- [`ENVIRONMENTS.md`](./ENVIRONMENTS.md) — the `mc-test.yml` matrix + provisioning.
- [`../gradle-plugin/README.md`](../gradle-plugin/README.md) — the Gradle front door in depth.
- [`PROTOCOL.md`](./PROTOCOL.md) · [`SELECTORS.md`](./SELECTORS.md) · [`CAPABILITIES.md`](./CAPABILITIES.md) · [`ARCHITECTURE.md`](./ARCHITECTURE.md) — design/contract docs.
</content>
