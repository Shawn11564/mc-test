// A fixture mod for the code-coverage spike (tests/e2e/run-coverage.mjs, lane fabric-strip): a common class with a
// client-only (@Environment(CLIENT)) method, which Fabric strips on a dedicated server. Standalone, like the agents.
pluginManagement {
    repositories {
        maven("https://maven.fabricmc.net/") {
            name = "Fabric"
        }
        gradlePluginPortal()
        mavenCentral()
    }
}

rootProject.name = "mc-test-fixture-env-strip"
