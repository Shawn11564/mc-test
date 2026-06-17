// OpenRegions (mod form) — the CLIENT-GUI variant of the canonical "regions" SUT.
//
// ============================================================================================
// ACCEPTANCE-ONLY BUILD. Fabric Loom needs network access + a Minecraft/Yarn download, so this
// CANNOT build in this repo's offline CI. The sources are written CORRECTLY (valid Java/Gradle,
// correct canonical testIds) and verified by inspection; the jar is produced on a provisioned
// machine when you run the rendered-client (inprocess) matrix target. Mirrors the same
// acceptance-only posture as `agents/client-fabric`.
// ============================================================================================

plugins {
    java
    // Pin Loom; the exact patch is provisioned externally. (Acceptance-only — not resolved here.)
    id("fabric-loom") version "1.7.4"
}

base {
    // Output → build/libs/openregions-fabric.jar (injected as regions.jar by the fabric-1.21-client row).
    archivesName.set("openregions-fabric")
}

// Drop the version suffix from ALL archive tasks (jar + Loom's remapJar) so the produced jar is exactly
// `openregions-fabric.jar` — matching the mc-test.yml `mods:` path. (project.version is still used for the
// maven coordinate + the fabric.mod.json ${version} stamp; only the file name is pinned.)
tasks.withType<AbstractArchiveTask>().configureEach {
    archiveVersion.set("")
}

loom {
    // Sources live under src/client/java — this is a client-only SUT (real client Screens).
    // Split source sets so the `client` entrypoint compiles against client-only Minecraft classes.
    splitEnvironmentSourceSets()

    mods {
        create("openregions") {
            sourceSet(sourceSets["main"])
            sourceSet(sourceSets["client"])
        }
    }
}

version = "0.1.0"
group = "com.example"

repositories {
    // TestIdHolder comes from the published agent core (io.mctest:mc-test-agent-core:0.1.0) —
    // the SAME coordinate the example plugin's pom.xml consumes. Component A publishes it via
    // `gradle :core:publishToMavenLocal` before this build runs.
    mavenLocal()
    mavenCentral()
    maven("https://maven.fabricmc.net/") { name = "Fabric" }
}

// Pin per (loader × MC version); MC 1.21.1 matches the inprocess matrix row in mc-test.yml.
val minecraftVersion = "1.21.1"
val yarnMappings = "1.21.1+build.3"
val loaderVersion = "0.16.5"
val fabricApiVersion = "0.103.0+1.21.1"

dependencies {
    minecraft("com.mojang:minecraft:$minecraftVersion")
    mappings("net.fabricmc:yarn:$yarnMappings:v2")
    modImplementation("net.fabricmc:fabric-loader:$loaderVersion")
    modImplementation("net.fabricmc.fabric-api:fabric-api:$fabricApiVersion")

    // The TestIdHolder marker interface the SUT widgets implement so the client agent reads a
    // stable testId. `compileOnly` (provided) — at runtime the class is supplied by the
    // client-fabric agent's bundled core (its classloader owns io.mctest.agent.core.client.*),
    // so we compile against it but DO NOT bundle a second copy. The widgets live in the `client`
    // source set, so the marker must be on the client compile classpath too.
    compileOnly("io.mctest:mc-test-agent-core:0.1.0")
    "clientCompileOnly"("io.mctest:mc-test-agent-core:0.1.0")
}

java {
    sourceCompatibility = JavaVersion.VERSION_21
    targetCompatibility = JavaVersion.VERSION_21
}

tasks.withType<JavaCompile>().configureEach {
    options.encoding = "UTF-8"
    options.release.set(21)
}

tasks.processResources {
    inputs.property("version", project.version)
    filesMatching("fabric.mod.json") {
        expand("version" to project.version)
    }
}
