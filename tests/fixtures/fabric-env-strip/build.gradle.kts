// The env-strip fixture (see settings.gradle.kts): built with Loom like server-fabric, so its jar is remapped the way
// a real Fabric mod's is. `./gradlew build` → build/libs/fixture-env-strip-1.21.1.jar.
plugins {
    java
    id("fabric-loom") version "1.7-SNAPSHOT"
}

group = "io.mctest"
version = "0.1.0"

val minecraftVersion = "1.21.1"

base {
    archivesName.set("fixture-env-strip")
}

tasks.withType<AbstractArchiveTask>().configureEach {
    archiveVersion.set(minecraftVersion)
}

java {
    toolchain {
        languageVersion.set(JavaLanguageVersion.of(21))
    }
}

repositories {
    maven("https://maven.fabricmc.net/") {
        name = "Fabric"
    }
    mavenCentral()
}

dependencies {
    minecraft("com.mojang:minecraft:$minecraftVersion")
    mappings("net.fabricmc:yarn:1.21.1+build.3:v2")
    modImplementation("net.fabricmc:fabric-loader:0.16.5")
    modImplementation("net.fabricmc.fabric-api:fabric-api:0.102.0+1.21.1")
}

tasks.withType<JavaCompile>().configureEach {
    options.encoding = "UTF-8"
    options.release.set(21)
}
