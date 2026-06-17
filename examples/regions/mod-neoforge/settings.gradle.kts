// OpenRegions (NeoForge SUT) — STANDALONE Gradle build (NOT part of agents/ or the npm workspace).
//
// A NeoGradle mod that needs the Minecraft toolchain + network (NeoForge + Mojmap, a real client), so
// it is kept out of any aggregate build. Mirrors the agents/client-neoforge toolchain so the SUT
// co-loads with that agent in one rendered client.

pluginManagement {
    repositories {
        maven("https://maven.neoforged.net/releases") {
            name = "NeoForged"
        }
        gradlePluginPortal()
        mavenCentral()
    }
}

rootProject.name = "openregions-neoforge"
