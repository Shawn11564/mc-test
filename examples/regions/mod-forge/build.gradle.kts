// OpenRegions (Forge mod form) — the canonical "regions" SUT built for Forge.
//
// Mirrors the agents/client-forge toolchain (ForgeGradle, MC 1.20.1, Forge 47.2.0, official mappings,
// Java 17) so this SUT co-loads with the client-forge agent in ONE rendered client. It has ZERO mc-test
// coupling — no dependency on the agent core — so the agent drives it purely through the real UI (label
// + role selectors). This makes it a black-box SUT and sidesteps any cross-mod class visibility on
// Forge's module system. ForgeGradle's default reobfJar reobfuscates the produced jar to SRG for the
// production client. ACCEPTANCE-ONLY: needs the Minecraft toolchain + network, so it is a standalone
// build run on a provisioned machine.

plugins {
    java
    id("net.minecraftforge.gradle") version "[6.0,6.2)"
}

group = "com.example"
version = "0.1.0"

// Pinned to the client-forge agent's (loader × MC) line so SUT + agent share one mapping regime.
val minecraftVersion = "1.20.1"
val forgeVersion = "47.2.0"
val mappingsChannel = "official"
val mappingsVersion = "1.20.1"
val loaderRange = "47"
val forgeRange = "47.2.0"

base {
    // Output → build/libs/openregions-forge.jar (injected as regions.jar by the forge-1.20.1-client row).
    archivesName.set("openregions-forge")
}

tasks.withType<AbstractArchiveTask>().configureEach {
    archiveVersion.set("")
}

java {
    // MC 1.20.1 targets Java 17 (Forge enforces this).
    toolchain {
        languageVersion.set(JavaLanguageVersion.of(17))
    }
}

repositories {
    mavenLocal()
    maven("https://maven.minecraftforge.net/") {
        name = "MinecraftForge"
    }
    mavenCentral()
}

configure<net.minecraftforge.gradle.userdev.UserDevExtension> {
    mappings(mappingsChannel, mappingsVersion)
}

dependencies {
    minecraft("net.minecraftforge:forge:$minecraftVersion-$forgeVersion")
    // No mc-test dependency: the SUT is a plain Forge mod the agent drives via label + role selectors.
}

tasks.withType<JavaCompile>().configureEach {
    options.encoding = "UTF-8"
    options.release.set(17)
}

tasks.named<ProcessResources>("processResources") {
    val props = mapOf(
        "version" to project.version,
        "minecraftVersion" to minecraftVersion,
        "loaderRange" to loaderRange,
        "forgeRange" to forgeRange,
    )
    inputs.properties(props)
    filesMatching("META-INF/mods.toml") {
        expand(props)
    }
}
