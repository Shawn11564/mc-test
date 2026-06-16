// mc-test client-forge agent — ForgeGradle BUILD CONFIG.
//
// !!! ACCEPTANCE-ONLY — NOT BUILT IN THIS REPO'S CI. !!!
// ForgeGradle downloads Minecraft + the MCP/official mappings + the Forge userdev and needs the network
// + a real client runtime, so this module is a STANDALONE Gradle build kept out of
// `agents/settings.gradle.kts`. The CI-provable half of the client agent (the loader-neutral screen
// logic) lives in /agents/core and is exercised there with a FakeClientBridge (no Minecraft). This shim
// only supplies the entrypoint and the MCP-SRG/official-name `mappings/Names.java` ClientBridge impl.
//
// The thin shim is the ONLY thing that recompiles per (loader × MC version) — Prime Directive 2.
// Obfuscation-mapped names are quarantined to `mappings/Names.java`; a CI import-scan fails if any
// `net.minecraft.*` import appears elsewhere.

import com.github.jengelman.gradle.plugins.shadow.tasks.ShadowJar

plugins {
    java
    // Pin ForgeGradle; a real build resolves it from the MinecraftForge maven (see settings.gradle.kts).
    id("net.minecraftforge.gradle") version "[6.0,6.2)"
    // Shadow shades the core + Java-WebSocket into the mod jar (Forge has no jar-in-jar `include`).
    id("com.github.johnrengelman.shadow") version "8.1.1"
}

group = "io.mctest"
version = "0.1.0"

// Pinned to one (loader × MC) build; M5 fans this out by swapping these coordinates + mappings/Names.
val minecraftVersion = "1.20.1"
val forgeVersion = "47.2.0"
val mappingsChannel = "official"
val mappingsVersion = "1.20.1"
// The loader/forge version ranges stamped into mods.toml.
val loaderRange = "47"
val forgeRange = "47.2.0"

base {
    // ENVIRONMENTS naming `agent-<variant>-<mc>.jar`.
    archivesName.set("agent-client-forge")
}

// Drop the version suffix from ALL archive tasks (jar + shadowJar) so the produced jar is exactly
// `agent-client-forge.jar` — the name the runner's KNOWN_CLIENT_AGENTS resolves (cli.ts). project.version
// still drives the maven coordinate + mods.toml ${version}; only the output file name is pinned.
tasks.withType<AbstractArchiveTask>().configureEach {
    archiveVersion.set("")
}

java {
    // MC 1.20.1 targets Java 17 (Forge enforces this); core was published at release 17 so it loads fine.
    toolchain {
        languageVersion.set(JavaLanguageVersion.of(17))
    }
}

repositories {
    // The shared agent core, published locally by `gradle :core:publishToMavenLocal` (in /agents).
    mavenLocal()
    maven("https://maven.minecraftforge.net/") {
        name = "MinecraftForge"
    }
    mavenCentral()
}

// ForgeGradle's userdev mapping configuration (official/Mojmap names; MCP-SRG at the bytecode layer).
configure<net.minecraftforge.gradle.userdev.UserDevExtension> {
    mappings(mappingsChannel, mappingsVersion)
}

// Shade the core + transport so the produced jar carries them (Forge has no Loom `include` jar-in-jar).
val shade: Configuration by configurations.creating

dependencies {
    minecraft("net.minecraftforge:forge:$minecraftVersion-$forgeVersion")

    // The shared MCTP core (MctpServer, Dispatch, EventBus, ClientBridge, ScreenHandlers, ClientAgent).
    // Shaded into the mod jar so the running client carries it without a separate jar.
    implementation("io.mctest:mc-test-agent-core:0.1.0")
    shade("io.mctest:mc-test-agent-core:0.1.0")

    // Java-WebSocket is the MCTP transport the core needs at runtime; shade it in too.
    implementation("org.java-websocket:Java-WebSocket:1.5.7")
    shade("org.java-websocket:Java-WebSocket:1.5.7")
}

tasks.withType<JavaCompile>().configureEach {
    options.encoding = "UTF-8"
    options.release.set(17)
}

tasks.named<ProcessResources>("processResources") {
    // Stamp the runtime versions into mods.toml so a real build pins the matching deps.
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

tasks.named<ShadowJar>("shadowJar") {
    // The shaded jar IS the mod jar (no classifier) — output is exactly `agent-client-forge.jar`.
    archiveClassifier.set("")
    configurations = listOf(shade)
}

// Make `build` produce the shaded jar (ForgeGradle reobf hooks the primary jar in a real build).
tasks.named("assemble") {
    dependsOn(tasks.named("shadowJar"))
}
