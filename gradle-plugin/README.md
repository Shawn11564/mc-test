# mc-test-gradle — the JVM / IntelliJ front door

Run mc-test from Gradle (and natively from IntelliJ's Gradle tool window). Applying the
plugin to a Minecraft **plugin/mod** project gives you `./gradlew mcTest`, which builds the
SUT jar and runs your `.mctest.yml` tests against an **ephemeral, mc-test-owned** server,
emitting JUnit. It is a **thin front door over the Node runner** — the engine stays the
single source of truth; this plugin shells out to it with the freshly-built jar wired in.

## Apply

```kotlin
// settings.gradle.kts
pluginManagement { repositories { mavenLocal(); gradlePluginPortal() } }

// build.gradle.kts
plugins {
    java
    id("io.mctest.mc-test") version "0.1.0"
}
```

> Until the engine is published (the v1.0 distribution decision — see `docs/V1_PLAN.md`),
> resolve the plugin from `mavenLocal()` after `gradle -p gradle-plugin publishToMavenLocal`.

## Run

```bash
./gradlew mcTest                 # build the jar → boot an ephemeral server → run all tests
./gradlew mcTestPaper1204        # one generated task per configured target
```

In IntelliJ: open the Gradle tool window → `verification` → `mcTest` (gutter ▶ / run config).

## Clean up the workspace

mc-test provisions each run into an **ephemeral** env dir under `.mc-test/run/`; successful
envs are auto-removed and a startup sweep reclaims any orphans, so it stays bounded. To
reclaim it on demand:

```bash
./gradlew mcTestClean                  # remove finished/orphaned env dirs (leaves live runs alone)
./gradlew mcTestClean --dry-run        # report reclaimable space without deleting
./gradlew mcTestClean --all            # remove EVERY env dir (incl. reuse + live)
./gradlew mcTestClean --runtime        # also clear the shared runtime cache (~130 MB/build)
```

`mcTestClean` is a thin front door over `mc-test clean` (it honors the matrix's `workDir`/
`cacheDir`). See `docs/ENVIRONMENTS.md` §2.9–2.11 for the workspace + shared-runtime-cache model.

## Configure

Everything has a convention; a project that follows the defaults needs no `mcTest { }` block.

```kotlin
mcTest {
    matrix.set(file("mc-test.yml"))          // default: mc-test.yml at the project root
    tests.from("src/mctest")                 // default: src/mctest/**/*.mctest.yml
    targets.set(listOf("paper-1.20.4"))      // default: empty → the whole matrix
    reportDir.set(layout.buildDirectory.dir("mc-test-report"))
    sutJarTask.set("jar")                    // "shadowJar" / "remapJar" for fat / mod jars
    nodeExecutable.set("node")               // the Node used to run the engine
    // runnerCli.set(file("…/dist/cli.js"))  // explicit; otherwise auto-detected
    addSpiDependency.set(true)               // auto compileOnly the agent-core SPI
    wireIntoCheck.set(false)                 // make `check` depend on mcTest
}
```

The SUT jar is wired from the build graph (`mcTest` `dependsOn` the jar task and passes its
output to the runner via `--plugin`), so **`mc-test.yml` never hand-references a jar path**.

## Server-truth SPI

To make `assertPluginState` / fixtures resolve against real plugin state, register the SPIs
(shipped in `io.mctest:mc-test-agent-core`, added as `compileOnly` automatically):

```java
getServer().getServicesManager().register(
    McTestStateProvider.class, new MyStateProvider(), this, ServicePriority.Normal);
getServer().getServicesManager().register(
    McTestFixtureProvider.class, new MyFixtureProvider(), this, ServicePriority.Normal);
```

See `examples/regions/plugin` (`RegionsStateProvider` / `RegionsFixtureProvider`) for a
complete example; `examples/regions/plugin-gradle` applies this plugin end-to-end.

## Editor autocomplete for `.mctest.yml`

Register the authoring schema (`packages/protocol/schema/mctest-stepfile.schema.json`, also
shipped in `@mc-test/protocol`) for `*.mctest.yml`:

- **Modeline (portable):** add to the top of a step file —
  `# yaml-language-server: $schema=<path-or-URL-to>/mctest-stepfile.schema.json`
- **IntelliJ:** Settings → Languages & Frameworks → Schemas → JSON Schema Mappings →
  map file pattern `*.mctest.yml` to the schema.

## Requirements & current limitations

- **Node on PATH** (or `nodeExecutable`), plus the `@mc-test/runner` engine. The plugin
  auto-detects the runner CLI (`node_modules/@mc-test/runner`, or the monorepo build). Fully
  automatic Node provisioning (a pinned toolchain) and resolving the engine as a published
  package land with the v1.0 distribution decision.
- **A jar-producing plugin applied first** (`java` / `java-library` / a mod loader plugin).
- **Deferred (stretch):** `mcTestWatch` warm/redeploy mode and a JUnit 5 `TestEngine` that
  surfaces each `(test × target)` cell in IntelliJ's test tree.
