// mc-test server-fabric agent — STANDALONE Gradle build (NOT part of agents/settings.gradle.kts).
//
// This shim is a Fabric Loom mod that needs the Minecraft toolchain + network (Yarn mappings, the
// Fabric loader/API, a real dedicated server). It is therefore kept OUT of the `mc-test-agents` build
// so that `gradle :core:build :server-bukkit:build` stays fast and offline. It consumes the shared core
// from mavenLocal (`io.mctest:mc-test-agent-core:0.1.0`), exactly like the client-fabric agent — run
// `gradle :core:publishToMavenLocal` (in /agents) first.
//
// ACCEPTANCE-ONLY in this repo's CI: this build is NOT run here (no Loom, no network). It is written to
// be correct against the contract; the CI-provable server logic lives in /agents/core (the cross-driver
// ConformanceTest) and is mirrored verbatim from /agents/server-bukkit.

pluginManagement {
    repositories {
        // Fabric Loom + Fabric tooling.
        maven("https://maven.fabricmc.net/") {
            name = "Fabric"
        }
        gradlePluginPortal()
        mavenCentral()
    }
}

rootProject.name = "mc-test-server-fabric"
