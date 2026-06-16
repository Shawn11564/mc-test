// mc-test client-neoforge agent — NeoGradle BUILD CONFIG.
//
// !!! ACCEPTANCE-ONLY — NOT BUILT IN THIS REPO'S CI. !!!
// NeoGradle downloads Minecraft + NeoForge and needs the network + a real client runtime, so this
// module is a STANDALONE Gradle build kept out of `agents/settings.gradle.kts`. The CI-provable half of
// the client agent (the loader-neutral screen logic) lives in /agents/core and is exercised there with a
// FakeClientBridge (no Minecraft). This shim only supplies the entrypoint and the Mojmap-mapped
// `mappings/Names.java` ClientBridge impl.
//
// The thin shim is the ONLY thing that recompiles per (loader × MC version) — Prime Directive 2.
// NeoForge ships OFFICIAL Mojang (Mojmap) names; they are quarantined to `mappings/Names.java`; a CI
// import-scan fails if any `net.minecraft.*` import appears elsewhere.

plugins {
    java
    // Pin NeoGradle (the NeoForge userdev plugin); a real build resolves it from the NeoForged maven
    // (see settings.gradle.kts).
    id("net.neoforged.gradle.userdev") version "7.0.171"
}

group = "io.mctest"
version = "0.1.0"

// Pinned to one (loader × MC) build; M5 fans this out by swapping these coordinates + mappings/Names.
val minecraftVersion = "1.21.1"
val neoForgeVersion = "21.1.66"

base {
    // ENVIRONMENTS naming `agent-<variant>-<mc>.jar`; NeoGradle appends nothing extra to the jar task.
    archivesName.set("agent-client-neoforge")
}

// Drop the version suffix from ALL archive tasks so the produced jar is exactly `agent-client-neoforge.jar`
// — the name the runner's KNOWN_CLIENT_AGENTS resolves (cli.ts). project.version still drives the maven
// coordinate + neoforge.mods.toml ${version}; only the output file name is pinned.
tasks.withType<AbstractArchiveTask>().configureEach {
    archiveVersion.set("")
}

java {
    // MC 1.21.x targets Java 21; core was published at release 17 so it loads fine.
    toolchain {
        languageVersion.set(JavaLanguageVersion.of(21))
    }
}

repositories {
    // The shared agent core, published locally by `gradle :core:publishToMavenLocal` (in /agents).
    mavenLocal()
    maven("https://maven.neoforged.net/releases") {
        name = "NeoForged"
    }
    mavenCentral()
}

dependencies {
    // NeoForge (the loader; pulls in Mojmap-mapped Minecraft). One coordinate, unlike Fabric's
    // minecraft + mappings + loader + api split.
    implementation("net.neoforged:neoforge:$neoForgeVersion")

    // The shared MCTP core (MctpServer, Dispatch, EventBus, ClientBridge, ScreenHandlers, ClientAgent).
    // jarJar'd into the mod jar so the running client carries it without a separate jar.
    jarJar(implementation("io.mctest:mc-test-agent-core:0.1.0")!!)

    // Java-WebSocket is the MCTP transport the core needs at runtime; nest it too.
    jarJar(implementation("org.java-websocket:Java-WebSocket:1.5.7")!!)
}

tasks.withType<JavaCompile>().configureEach {
    options.encoding = "UTF-8"
    options.release.set(21)
}

tasks.named<ProcessResources>("processResources") {
    // Stamp the runtime versions into neoforge.mods.toml so a real build pins the matching deps.
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
