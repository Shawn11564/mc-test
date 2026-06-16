pluginManagement {
    repositories {
        // The mc-test front-door plugin (io.mctest.mc-test), published locally in F6 via
        // `gradle -p gradle-plugin publishToMavenLocal`. Once the engine is published
        // (F0 release gate) this resolves from a public repo / the plugin portal instead.
        mavenLocal()
        gradlePluginPortal()
    }
}
rootProject.name = "regions-plugin-gradle"
