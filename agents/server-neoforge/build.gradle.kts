// mc-test server-neoforge agent — NeoGradle BUILD CONFIG.
//
// STANDALONE Gradle build (kept out of `agents/settings.gradle.kts` so the core/server-bukkit build stays
// fast + offline): NeoGradle downloads Minecraft + NeoForge, so this module needs network + a JDK 21
// toolchain. It IS built + booted for real — the e2e `modded-server` lane (.github/workflows/e2e.yml)
// builds `agent-server-neoforge.jar` and `tests/e2e/run-modded-server-boot.mjs` boots a real NeoForge
// 1.21.1 dedicated server with it and asserts `mod.loaded = true` over MCTP (verified 2026-06-22, alongside
// the Fabric + Forge servers). The loader-neutral wire logic + handler skeleton are additionally covered
// offline at /agents/core (the cross-driver ConformanceTest) and mirror /agents/server-bukkit +
// /agents/server-fabric; this shim supplies only the entrypoint and the Mojmap-mapped
// `mappings/Names.java` server facade.
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

// Pinned to one (loader × MC) build; fanned out by swapping these coordinates + mappings/Names.
val minecraftVersion = "1.21.1"
val neoForgeVersion = "21.1.234"

base {
    // ENVIRONMENTS naming `agent-<variant>-<mc>.jar`; NeoGradle appends nothing extra to the jar task.
    archivesName.set("agent-server-neoforge")
}

// Drop the version suffix from ALL archive tasks so the produced jar is exactly `agent-server-neoforge.jar`
// — the name the runner's KNOWN_AGENTS resolves (cli.ts). project.version still drives the maven
// coordinate + neoforge.mods.toml ${version}; only the output file name is pinned.
tasks.withType<AbstractArchiveTask>().configureEach {
    archiveVersion.set("")
}

// The RUNNABLE mod jar must carry the nested core + Java-WebSocket + Gson (jarJar output), and the runner
// resolves it as exactly `agent-server-neoforge.jar`. By default NeoGradle's `jarJar` task emits the
// nested jar with an `-all` classifier while the plain `jar` (no nested deps) owns the bare name — so the
// runner would load a coreless jar and the agent would ClassNotFound at boot. Swap them: give the plain
// jar a `slim` classifier and let `jarJar` own the canonical name. (Mirrors the client-neoforge agent's
// jarJar classifier handling.)
tasks.named<AbstractArchiveTask>("jar") {
    archiveClassifier.set("slim")
}
tasks.named<AbstractArchiveTask>("jarJar") {
    archiveClassifier.set("")
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

    // The shared MCTP core (MctpServer, Dispatch, EventBus, the SPI interfaces).
    // jarJar'd into the mod jar so the running server carries it without a separate jar.
    jarJar(implementation("io.mctest:mc-test-agent-core:0.1.0")!!)

    // Java-WebSocket is the MCTP transport the core needs at runtime; nest it too. Exclude its slf4j-api
    // transitive: NeoForge runs under the Java module system and already provides an `org.slf4j` module,
    // so nesting slf4j here would split the `org.slf4j.*` packages → a boot-time ResolutionException
    // (the same conflict the forge agent's shadowJar excludes). Java-WebSocket logs through NeoForge's slf4j.
    jarJar(implementation("org.java-websocket:Java-WebSocket:1.5.7") { exclude(group = "org.slf4j") }!!)

    // Gson: NeoForge/Minecraft already ships `com.google.gson` as a module on the boot module path, so
    // nesting our own copy makes `mc.test.agent.core` read TWO `com.google.gson` modules → a boot-time
    // `ResolutionException: reads more than one module named com.google.gson` (the same JPMS split the
    // slf4j exclude above avoids; verified against a real NeoForge 1.21.1 dedicated-server boot). The
    // core's JSON code resolves against the loader-provided Gson at runtime, so Gson is a plain
    // `implementation` (compile-only here; on the test classpath below) and is NOT nested.
    implementation("com.google.code.gson:gson:2.11.0")

    // --- Tests ---------------------------------------------------------------
    // Fast PURE-JAVA unit tests of the loader-neutral helpers (Params/StateQuery/FixtureLedger): no
    // server runtime, mirror /agents/server-bukkit + /agents/server-fabric. Gson is on the test classpath
    // (the mod nests it, but tests compile/run on their own classpath).
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
