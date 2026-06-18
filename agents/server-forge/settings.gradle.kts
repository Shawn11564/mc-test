// mc-test server-forge agent — STANDALONE Gradle build (NOT part of agents/settings.gradle.kts).
//
// This shim is a ForgeGradle mod that needs the Minecraft toolchain + network (MCP/official mappings,
// the Forge userdev, a real dedicated server). It is therefore kept OUT of the `mc-test-agents` build so
// that `gradle :core:build :server-bukkit:build` stays fast and offline. It consumes the shared core from
// mavenLocal (`io.mctest:mc-test-agent-core:0.1.0`), exactly like the server-fabric agent — run
// `gradle :core:publishToMavenLocal` (in /agents) first.
//
// ACCEPTANCE-ONLY in this repo's CI: this build is NOT run here (no ForgeGradle, no network). It is
// written to be correct against the contract; the CI-provable server logic lives in /agents/core (the
// cross-driver ConformanceTest) and is mirrored verbatim from /agents/server-bukkit + /agents/server-fabric.

pluginManagement {
    repositories {
        // ForgeGradle + Shadow plugins.
        maven("https://maven.minecraftforge.net/") {
            name = "MinecraftForge"
        }
        gradlePluginPortal()
        mavenCentral()
    }
}

rootProject.name = "mc-test-server-forge"
