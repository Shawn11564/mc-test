// mc-test server-forge agent — ForgeGradle BUILD CONFIG.
//
// !!! ACCEPTANCE-ONLY — NOT BUILT IN THIS REPO'S CI. !!!
// ForgeGradle downloads Minecraft + the MCP/official mappings + the Forge userdev and needs the network
// + a real (dedicated) server runtime, so this module is a STANDALONE Gradle build kept out of
// `agents/settings.gradle.kts`. The CI-provable half of the server agent (the loader-neutral wire logic +
// the pure-Java handler skeleton) lives in /agents/core (the cross-driver ConformanceTest) and is mirrored
// from /agents/server-bukkit and /agents/server-fabric. This shim only supplies the entrypoint and the
// Mojmap/official-name `mappings/Names.java` server facade.
//
// The thin shim is the ONLY thing that recompiles per (loader × MC version) — Prime Directive 2.
// Obfuscation-mapped names are quarantined to `mappings/Names.java`; a CI import-scan fails if any
// `net.minecraft.*` import appears elsewhere.

import com.github.jengelman.gradle.plugins.shadow.tasks.ShadowJar

plugins {
    java
    // Pin ForgeGradle; a real build resolves it from the MinecraftForge maven (see settings.gradle.kts).
    id("net.minecraftforge.gradle") version "[6.0,6.2)"
    // Shadow shades the core + Java-WebSocket + Gson into the mod jar (Forge has no jar-in-jar `include`).
    id("com.github.johnrengelman.shadow") version "8.1.1"
}

group = "io.mctest"
version = "0.1.0"

// Pinned to one (loader × MC) build; fanned out by swapping these coordinates + mappings/Names.
// NOTE: Forge 47.3.39 is a REAL published 1.20.1 build (47.2.0 does NOT exist).
val minecraftVersion = "1.20.1"
val forgeVersion = "47.3.39"
val mappingsChannel = "official"
val mappingsVersion = "1.20.1"
// The loader/forge version ranges stamped into mods.toml.
val loaderRange = "47"
val forgeRange = "47.3.39"

base {
    // ENVIRONMENTS naming `agent-<variant>-<mc>.jar`.
    archivesName.set("agent-server-forge")
}

// Drop the version suffix from ALL archive tasks (jar + shadowJar) so the produced jar is exactly
// `agent-server-forge.jar` — the name the runner's KNOWN_AGENTS resolves (cli.ts). project.version still
// drives the maven coordinate + mods.toml ${version}; only the output file name is pinned.
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

// Shade the core + transport + Gson so the produced jar carries them (Forge has no Loom `include`).
val shade: Configuration by configurations.creating

dependencies {
    minecraft("net.minecraftforge:forge:$minecraftVersion-$forgeVersion")

    // The shared MCTP core (MctpServer, Dispatch, EventBus, the SPI interfaces).
    // Shaded into the mod jar so the running server carries it without a separate jar.
    implementation("io.mctest:mc-test-agent-core:0.1.0")
    shade("io.mctest:mc-test-agent-core:0.1.0")

    // Java-WebSocket is the MCTP transport the core needs at runtime; shade it in too.
    implementation("org.java-websocket:Java-WebSocket:1.5.7")
    shade("org.java-websocket:Java-WebSocket:1.5.7")

    // Gson: like the server-fabric agent (and UNLIKE the Bukkit agent, where Paper ships Gson at
    // runtime), a vanilla Forge DEDICATED SERVER does not reliably put Gson on the mod classloader for
    // our classes, so shade it in to guarantee the envelope/JSON code resolves at runtime. See README.
    implementation("com.google.code.gson:gson:2.11.0")
    shade("com.google.code.gson:gson:2.11.0")

    // --- Tests ---------------------------------------------------------------
    // Fast PURE-JAVA unit tests of the loader-neutral helpers (Params/StateQuery/FixtureLedger): no
    // server runtime, mirror /agents/server-bukkit + /agents/server-fabric. Gson is on the test classpath
    // (the mod shades it, but tests compile/run on their own classpath).
    testImplementation("com.google.code.gson:gson:2.11.0")
    testImplementation(platform("org.junit:junit-bom:5.10.2"))
    testImplementation("org.junit.jupiter:junit-jupiter")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

// This is a STANDALONE build (not under agents/build.gradle.kts), so configure the test task here.
tasks.named<Test>("test") {
    useJUnitPlatform()
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

// ForgeGradle's reobfJar reobfuscates the plain `jar`, whose default output (agent-server-forge.jar)
// COLLIDES with shadowJar's — Gradle flags the implicit dependency. Give the plain jar a "dev" classifier
// so only shadowJar owns the clean `agent-server-forge.jar` the runner's KNOWN_AGENTS resolves.
tasks.named<Jar>("jar") {
    archiveClassifier.set("dev")
}

tasks.named<ShadowJar>("shadowJar") {
    // The shaded jar IS the mod jar (no classifier) — output is exactly `agent-server-forge.jar`.
    archiveClassifier.set("")
    configurations = listOf(shade)
    // Forge/NeoForge run under the Java module system (BootstrapLauncher): shading slf4j here would make
    // `mctestserverforge` and Forge's own `org.slf4j` module BOTH export `org.slf4j.*` → a split-package
    // ResolutionException at boot. Forge already provides slf4j on the module path and our (automatic)
    // module reads it, so drop the transitive copy Java-WebSocket pulled in. (Fabric needs no such
    // exclude — KnotClassLoader is not strict JPMS.)
    exclude("org/slf4j/**")
}

// Reobfuscate the SHADED jar from the official (Mojmap) names it was compiled against to the SRG names a
// PRODUCTION Forge 1.20.1 server runs with. Without this, mappings/Names.java's `net.minecraft.*` calls
// throw `NoSuchMethodError` at runtime — dev mode uses official names but a real (SRG) server is what runs.
// ForgeGradle's reobf already targets the plain `jar`; we add a reobf for `shadowJar` so the artifact the
// runner actually loads (agent-server-forge.jar) is SRG-mapped. Only mappings/Names.java carries
// net.minecraft references (the quarantine file); the shaded core + Java-WebSocket + Gson classes have
// none, so reobf leaves them untouched.
reobf {
    create("shadowJar")
}
tasks.named<ShadowJar>("shadowJar") {
    finalizedBy("reobfShadowJar")
}

// Make `build` produce the (reobfuscated) shaded jar.
tasks.named("assemble") {
    dependsOn(tasks.named("shadowJar"))
}
