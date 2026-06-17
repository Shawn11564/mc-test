// OpenRegions (Forge SUT) — STANDALONE Gradle build (NOT part of agents/ or the npm workspace).
//
// A ForgeGradle mod that needs the Minecraft toolchain + network (official mappings, the Forge
// userdev, a real client), so it is kept out of any aggregate build. It consumes the shared core
// marker from mavenLocal (io.mctest:mc-test-agent-core:0.1.0) — run `gradle :core:publishToMavenLocal`
// (in /agents) first. Mirrors the agents/client-forge toolchain so the SUT co-loads with that agent.

pluginManagement {
    repositories {
        maven("https://maven.minecraftforge.net/") {
            name = "MinecraftForge"
        }
        gradlePluginPortal()
        mavenCentral()
    }
}

rootProject.name = "openregions-forge"
