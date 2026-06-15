// Shared configuration for every mc-test JVM agent subproject.
// PROTOCOL.md is authoritative for the wire; this file only fixes group/version, the Java
// toolchain (release 17), and the repos each agent draws from.

plugins {
    java
}

allprojects {
    group = "io.mctest"
    version = "0.1.0"

    repositories {
        mavenCentral()
        // Paper API (used by the server-bukkit agent; compileOnly there).
        maven("https://repo.papermc.io/repository/maven-public/")
    }
}

subprojects {
    apply(plugin = "java")

    extensions.configure<JavaPluginExtension> {
        // Source/target 17 so the artifact runs on the example world's release=17,
        // built with the JDK 21 that is present.
        toolchain {
            languageVersion.set(JavaLanguageVersion.of(21))
        }
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    tasks.withType<JavaCompile>().configureEach {
        options.release.set(17)
        options.encoding = "UTF-8"
    }

    tasks.withType<Test>().configureEach {
        useJUnitPlatform()
        testLogging {
            events("passed", "skipped", "failed")
        }
    }
}
