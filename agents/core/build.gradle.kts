// @mc-test/agent-core — the shared, loader-neutral Java agent core (MCTP server side).
// Pure data + dispatch + WebSocket transport. NO game/Bukkit/Mojang types here.
// Published to mavenLocal as io.mctest:mc-test-agent-core so the server-bukkit agent and the
// regions SUT can compile against the SPI interfaces.

plugins {
    `java-library`
    `maven-publish`
}

dependencies {
    // WebSocket server transport (the MCTP byte pipe). `api` (not `implementation`) so downstream
    // agents that hold an MctpServer reference can resolve its WebSocketServer supertype at compile
    // time; it is still bundled into the agent fat-jar via runtimeClasspath.
    api("org.java-websocket:Java-WebSocket:1.5.7")

    // Gson is compileOnly: Paper provides it at runtime, so it is NOT bundled. The core only
    // references com.google.gson.* for JSON envelope construction.
    compileOnly("com.google.code.gson:gson:2.11.0")

    // Tests need a real Gson on the classpath plus a WebSocket client.
    testImplementation("com.google.code.gson:gson:2.11.0")
    testImplementation(platform("org.junit:junit-bom:5.10.2"))
    testImplementation("org.junit.jupiter:junit-jupiter")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

publishing {
    publications {
        create<MavenPublication>("mavenJava") {
            artifactId = "mc-test-agent-core"
            from(components["java"])
        }
    }
}
