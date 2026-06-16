// Sample: a Gradle-built Paper plugin that applies the mc-test front door (F6).
// It reuses the canonical OpenRegions SUT sources so there is ONE source of truth
// with the Maven build (examples/regions/plugin).
//
//   gradle -p examples/regions/plugin-gradle mcTest   (or ./gradlew mcTest / ▶ in IntelliJ)
//     → builds this plugin jar, boots an ephemeral Paper server, runs the co-located
//       regions test (incl. server-truth assertPluginState), writes JUnit under
//       build/mc-test-report. No mc-test.yml jar path is hand-edited — the freshly
//       built jar is wired from the build graph.
//
// Prereqs (monorepo dev): the agent core SPI + runner are available locally —
//   gradle -p agents :core:publishToMavenLocal :server-bukkit:jar
//   npm run build -w @mc-test/runner
plugins {
    java
    id("io.mctest.mc-test") version "0.1.0"
}

repositories {
    mavenCentral()
    maven("https://repo.papermc.io/repository/maven-public/")
    mavenLocal() // io.mctest:mc-test-agent-core (the SPI)
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

dependencies {
    compileOnly("io.papermc.paper:paper-api:1.20.4-R0.1-SNAPSHOT")
    // The McTestStateProvider / McTestFixtureProvider SPI is added as compileOnly
    // automatically by the mc-test plugin (mcTest.addSpiDependency = true).
}

// Reuse the canonical OpenRegions Java sources + plugin.yml (single source of truth).
sourceSets {
    named("main") {
        java.srcDir("../plugin/src/main/java")
        resources.srcDir("../plugin/src/main/resources")
    }
}

mcTest {
    matrix.set(file("mc-test.yml"))
    tests.from("../regions.mctest.yml") // the canonical regions step file
    targets.set(listOf("paper-1.20.4"))
}
