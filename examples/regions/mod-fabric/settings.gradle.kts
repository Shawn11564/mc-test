// OpenRegions (mod form) — STANDALONE Fabric Loom build.
//
// Deliberately NOT included in `agents/settings.gradle.kts`: Loom needs network access and a
// Minecraft/Yarn download, so it cannot run in this repo's offline CI (acceptance-only, like
// agents/client-fabric). Build it on a machine with Loom + network when you provision the
// rendered-client (inprocess) matrix target.

pluginManagement {
    repositories {
        maven("https://maven.fabricmc.net/") { name = "Fabric" }
        gradlePluginPortal()
        mavenCentral()
    }
}

rootProject.name = "openregions-mod"
