// mc-test client-neoforge agent — STANDALONE Gradle build (NOT part of agents/settings.gradle.kts).
//
// This shim is a NeoForge mod that needs the Minecraft toolchain + network (NeoForge + Mojmap mappings,
// a real client). It is therefore kept OUT of the `mc-test-agents` build so that
// `gradle :core:build :server-bukkit:build` stays fast and offline. It consumes the shared core from
// mavenLocal (`io.mctest:mc-test-agent-core:0.1.0`), exactly like the example regions plugin's Maven
// build — run `gradle :core:publishToMavenLocal` (in /agents) first.
//
// ACCEPTANCE-ONLY in this repo's CI: this build is NOT run here (no NeoGradle, no network). It is
// written to be correct against the contract; the CI-provable client logic lives in /agents/core (the
// loader-neutral ScreenHandlers + ClientBridge façade, exercised by FakeClientBridge).

pluginManagement {
    repositories {
        // NeoGradle (the NeoForge userdev plugin) + NeoForged tooling.
        maven("https://maven.neoforged.net/releases") {
            name = "NeoForged"
        }
        gradlePluginPortal()
        mavenCentral()
    }
}

rootProject.name = "mc-test-client-neoforge"
