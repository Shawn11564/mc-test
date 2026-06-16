// mc-test server-fabric agent — Fabric Loom BUILD CONFIG.
//
// !!! ACCEPTANCE-ONLY — NOT BUILT IN THIS REPO'S CI. !!!
// Fabric Loom downloads Minecraft + Yarn mappings and needs the network + a real (dedicated) server
// runtime, so this module is a STANDALONE Gradle build kept out of `agents/settings.gradle.kts`. The
// CI-provable half of the server agent (the loader-neutral wire logic + the pure-Java handler skeleton)
// lives in /agents/core (the cross-driver ConformanceTest) and is mirrored from /agents/server-bukkit.
// This shim only supplies the entrypoint and the Yarn-mapped `mappings/Names.java` server facade.
//
// The thin shim is the ONLY thing that recompiles per (loader × MC version) — Prime Directive 2.
// Obfuscation-mapped (Yarn) names are quarantined to `mappings/Names.java`; a CI import-scan fails if
// any `net.minecraft.*` import appears elsewhere.

plugins {
    java
    // Pin Loom; a real build resolves it from the Fabric maven (see settings.gradle.kts).
    id("fabric-loom") version "1.7-SNAPSHOT"
}

group = "io.mctest"
version = "0.1.0"

// Pinned to one (loader × MC) build; M5 fans this out by swapping these coordinates + mappings/Names.
val minecraftVersion = "1.21.1"
val yarnMappings = "1.21.1+build.3"
val loaderVersion = "0.16.5"
val fabricApiVersion = "0.102.0+1.21.1"

base {
    // ENVIRONMENTS naming `agent-<variant>-<mc>.jar`; loom appends nothing extra to remapJar.
    archivesName.set("agent-server-fabric")
}

// Drop the version suffix from ALL archive tasks (jar + Loom's remapJar) so the produced jar is exactly
// `agent-server-fabric.jar` — the name the runner's known-server-agents table resolves. project.version
// still drives the maven coordinate + fabric.mod.json ${version}; only the output file name is pinned.
tasks.withType<AbstractArchiveTask>().configureEach {
    archiveVersion.set("")
}

java {
    // MC 1.21.x targets Java 21 (Loom enforces this); core was published at release 17 so it loads fine.
    toolchain {
        languageVersion.set(JavaLanguageVersion.of(21))
    }
}

repositories {
    // The shared agent core, published locally by `gradle :core:publishToMavenLocal` (in /agents).
    mavenLocal()
    maven("https://maven.fabricmc.net/") {
        name = "Fabric"
    }
    mavenCentral()
}

dependencies {
    minecraft("com.mojang:minecraft:$minecraftVersion")
    mappings("net.fabricmc:yarn:$yarnMappings:v2")
    modImplementation("net.fabricmc:fabric-loader:$loaderVersion")
    modImplementation("net.fabricmc.fabric-api:fabric-api:$fabricApiVersion")

    // The shared MCTP core (MctpServer, Dispatch, EventBus, the SPI interfaces).
    // Shaded into the mod jar via `include(...)` so the running server carries it without a separate jar.
    include(implementation("io.mctest:mc-test-agent-core:0.1.0")!!)

    // Java-WebSocket is the MCTP transport the core needs at runtime; shade it in too.
    include(implementation("org.java-websocket:Java-WebSocket:1.5.7")!!)

    // Gson: UNLIKE the Bukkit agent (Paper ships Gson at runtime), a vanilla Fabric DEDICATED SERVER
    // does NOT reliably put Gson on the mod classloader for our classes, so shade it in via include(...)
    // (jar-in-jar) to guarantee the envelope/JSON code resolves at runtime. See README "Build".
    include(implementation("com.google.code.gson:gson:2.11.0")!!)
}

tasks.withType<JavaCompile>().configureEach {
    options.encoding = "UTF-8"
    options.release.set(21)
}

tasks.named<ProcessResources>("processResources") {
    // Stamp the runtime versions into fabric.mod.json so a real build pins the matching deps.
    val props = mapOf(
        "version" to project.version,
        "minecraftVersion" to minecraftVersion,
        "loaderVersion" to loaderVersion,
    )
    inputs.properties(props)
    filesMatching("fabric.mod.json") {
        expand(props)
    }
}
