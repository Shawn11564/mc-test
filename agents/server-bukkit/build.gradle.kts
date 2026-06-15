// mc-test server-bukkit agent — BUILD CONFIG ONLY (Component B writes the Java sources).
// Bukkit/Paper API only (no NMS/Mojang-mapped symbols) so no per-version remap is needed.
//
// Fat-jar strategy without a shadow plugin: paper-api and gson are compileOnly, so the only
// things on runtimeClasspath are Java-WebSocket + the core project (incl. the SPI). The `jar`
// task folds those into the artifact, leaving paper-api/gson to be provided at runtime.

plugins {
    java
}

dependencies {
    // Paper API — provided by the server at runtime; never bundled.
    compileOnly("io.papermc.paper:paper-api:1.20.4-R0.1-SNAPSHOT")

    // Gson — Paper ships it; compileOnly so it is not duplicated in the fat-jar.
    compileOnly("com.google.code.gson:gson:2.11.0")

    // Shared agent core (MctpServer, Dispatch, SPI, …). Bundled.
    implementation(project(":core"))

    // Gson on the TEST classpath (Paper provides it at runtime; tests exercise envelope params).
    testImplementation("com.google.code.gson:gson:2.11.0")
    testImplementation(platform("org.junit:junit-bom:5.10.2"))
    testImplementation("org.junit.jupiter:junit-jupiter")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.named<Jar>("jar") {
    archiveFileName.set("mc-test-agent-bukkit.jar")
    duplicatesStrategy = DuplicatesStrategy.EXCLUDE
    // runtimeClasspath holds only Java-WebSocket + :core classes here (paper-api/gson are
    // compileOnly), so unpacking it produces a self-contained agent jar. dependsOn keeps Gradle's
    // strict task-dependency validation happy (the fat jar consumes :core:jar's output).
    val runtimeClasspath = configurations.runtimeClasspath
    dependsOn(runtimeClasspath)
    from({ runtimeClasspath.get().map { if (it.isDirectory) it else zipTree(it) } })
    exclude("META-INF/*.SF", "META-INF/*.DSA", "META-INF/*.RSA", "module-info.class")
}
