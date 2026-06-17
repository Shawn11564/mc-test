// OpenRegions (NeoForge mod form) — the canonical "regions" SUT built for NeoForge.
//
// Mirrors the agents/client-neoforge toolchain (NeoGradle, MC 1.21.1, NeoForge 21.1.66, Mojmap, Java 21)
// so this SUT co-loads with the client-neoforge agent in ONE rendered client. It has ZERO mc-test
// coupling — no dependency on the agent core — so the agent drives it purely through the real UI (label
// + role selectors). NeoForge runs Mojmap (official) names at runtime, so there is NO reobf step.
// ACCEPTANCE-ONLY: needs the Minecraft toolchain + network, so it is a standalone build run on a
// provisioned machine.

plugins {
    java
    id("net.neoforged.gradle.userdev") version "7.0.171"
}

group = "com.example"
version = "0.1.0"

// Pinned to the client-neoforge agent's (loader × MC) line so SUT + agent share one mapping regime.
val minecraftVersion = "1.21.1"
val neoForgeVersion = "21.1.66"

base {
    // Output → build/libs/openregions-neoforge.jar (injected as regions.jar by the neoforge-1.21-client row).
    archivesName.set("openregions-neoforge")
}

tasks.withType<AbstractArchiveTask>().configureEach {
    archiveVersion.set("")
}

java {
    // MC 1.21.x targets Java 21.
    toolchain {
        languageVersion.set(JavaLanguageVersion.of(21))
    }
}

repositories {
    mavenLocal()
    maven("https://maven.neoforged.net/releases") {
        name = "NeoForged"
    }
    mavenCentral()
}

dependencies {
    // NeoForge (the loader; pulls in Mojmap-mapped Minecraft). No mc-test dependency: the SUT is a plain
    // NeoForge mod the agent drives via label + role selectors.
    implementation("net.neoforged:neoforge:$neoForgeVersion")
}

tasks.withType<JavaCompile>().configureEach {
    options.encoding = "UTF-8"
    options.release.set(21)
}

tasks.named<ProcessResources>("processResources") {
    val props = mapOf(
        "version" to project.version,
        "loaderVersionRange" to "[4,)",
        "neoVersionRange" to "[$neoForgeVersion,)",
        "minecraftVersionRange" to "[$minecraftVersion]",
    )
    inputs.properties(props)
    filesMatching("META-INF/neoforge.mods.toml") {
        expand(props)
    }
}
