package io.mctest.gradle;

import org.gradle.api.file.ConfigurableFileCollection;
import org.gradle.api.file.DirectoryProperty;
import org.gradle.api.file.RegularFileProperty;
import org.gradle.api.provider.ListProperty;
import org.gradle.api.provider.Property;

/**
 * The {@code mcTest { … }} configuration block. Everything has a convention so a
 * project applying the plugin can run {@code ./gradlew mcTest} with zero config if
 * it follows the defaults (an {@code mc-test.yml} at the project root and step files
 * under {@code src/mctest/}). Gradle instantiates this (abstract managed properties).
 */
public abstract class McTestExtension {

    /** The environment matrix file (targets). Default: {@code mc-test.yml} at the project root. */
    public abstract RegularFileProperty getMatrix();

    /** The {@code *.mctest.yml} step files to run. Default: {@code src/mctest/**}{@code /*.mctest.yml}. */
    public abstract ConfigurableFileCollection getTests();

    /** Where JUnit XML + artifacts are written. Default: {@code build/mc-test-report}. */
    public abstract DirectoryProperty getReportDir();

    /** Matrix target ids to run (empty → the whole matrix). Also generates {@code mcTest<Target>} tasks. */
    public abstract ListProperty<String> getTargets();

    /** Name of the task whose archive is the SUT jar to test. Default: {@code jar} ({@code shadowJar}/{@code remapJar} for fat/mod jars). */
    public abstract Property<String> getSutJarTask();

    /** The Node executable used to run the runner. Default: {@code node} (on PATH). */
    public abstract Property<String> getNodeExecutable();

    /** Explicit path to the runner CLI ({@code dist/cli.js}). If unset, it is auto-detected (walk up for {@code node_modules/@mc-test/runner} or the monorepo build). */
    public abstract RegularFileProperty getRunnerCli();

    /** Auto-add the agent-core SPI as a {@code compileOnly} dependency so SUTs compile against McTestStateProvider/McTestFixtureProvider. Default: true. */
    public abstract Property<Boolean> getAddSpiDependency();

    /** Coordinates of the agent-core SPI artifact. Default: {@code io.mctest:mc-test-agent-core:0.1.0}. */
    public abstract Property<String> getSpiCoordinates();

    /** Make {@code check} depend on {@code mcTest}. Default: false (so {@code check} doesn't boot servers unless opted in). */
    public abstract Property<Boolean> getWireIntoCheck();
}
