// mc-test-gradle — the JVM/IntelliJ front door (F6). A THIN Gradle plugin over the
// Node runner: `./gradlew mcTest` builds the SUT jar and runs mc-test against an
// ephemeral Minecraft server. It does NOT reimplement the runner (the Node engine
// stays the single source of truth); it shells out to it with the build-graph jar
// wired in via `--plugin`.
plugins {
    `java-gradle-plugin`
    `maven-publish`
}

group = "io.mctest"
version = "0.1.0"

java {
    // Compiled for Java 17 so it loads on any Gradle running on JDK 17+ (Gradle 9 here runs on 21).
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

tasks.withType<JavaCompile>().configureEach {
    options.encoding = "UTF-8"
}

gradlePlugin {
    plugins {
        create("mcTest") {
            id = "io.mctest.mc-test"
            implementationClass = "io.mctest.gradle.McTestPlugin"
            displayName = "mc-test Gradle front door"
            description = "Run mc-test (Minecraft plugin/mod testing) across an ephemeral server from Gradle / IntelliJ."
        }
    }
}
