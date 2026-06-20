package io.mctest.gradle;

import java.io.File;
import java.util.ArrayList;
import java.util.List;
import javax.inject.Inject;
import org.gradle.api.DefaultTask;
import org.gradle.api.GradleException;
import org.gradle.api.file.DirectoryProperty;
import org.gradle.api.file.RegularFileProperty;
import org.gradle.api.provider.Property;
import org.gradle.api.tasks.Input;
import org.gradle.api.tasks.Internal;
import org.gradle.api.tasks.Optional;
import org.gradle.api.tasks.TaskAction;
import org.gradle.api.tasks.options.Option;
import org.gradle.process.ExecOperations;
import org.gradle.work.DisableCachingByDefault;

/**
 * Scaffolds a GitHub Actions workflow into the project by shelling out to
 * {@code mc-test init-ci}. The generated {@code .github/workflows/mc-test.yml} builds the
 * SUT jar, runs the {@code .mctest.yml} tests across the matrix, and publishes the HTML
 * report ({@code mc-test-report/report.html}) as a downloadable workflow artifact + to
 * GitHub Pages. It never overwrites an existing workflow.
 *
 * <p>Options pass straight through to the CLI:
 * <ul>
 *   <li>{@code --standalone} — emit a self-contained workflow (no reusable-workflow dependency);</li>
 *   <li>{@code --agents "…"} — engine agents to build so server-truth steps run;</li>
 *   <li>{@code --build-command "…"} — override the auto-detected SUT build command;</li>
 *   <li>{@code --engine-ref …} — pin the mc-test engine ref CI builds against.</li>
 * </ul>
 *
 * <p>Like the run/clean tasks, the Node engine stays the single source of truth — this is
 * a thin front door. Never cacheable: it writes into the source tree.
 */
@DisableCachingByDefault(because = "Writes a workflow file into the source tree; a scaffolding action is never up-to-date")
public abstract class McTestInitCiTask extends DefaultTask {

    @Input
    public abstract Property<String> getNodeExecutable();

    /** Explicit runner {@code cli.js}; auto-detected from the project tree when unset. */
    @Internal
    public abstract RegularFileProperty getRunnerCli();

    /** Project dir — the runner's working directory + where the workflow is scaffolded. */
    @Internal
    public abstract DirectoryProperty getProjectDir();

    @Input
    @Optional
    @Option(option = "standalone", description = "Emit a self-contained workflow (clones + builds the engine inline; no reusable-workflow dependency).")
    public abstract Property<Boolean> getStandalone();

    @Input
    @Optional
    @Option(option = "agents", description = "Space-separated engine agents to build (e.g. \"server-fabric server-neoforge\").")
    public abstract Property<String> getAgents();

    @Input
    @Optional
    @Option(option = "build-command", description = "Command that builds the SUT jar(s); default auto-detected (Gradle/Maven).")
    public abstract Property<String> getBuildCommand();

    @Input
    @Optional
    @Option(option = "engine-ref", description = "mc-test engine ref CI builds against (default main; pin a tag for reproducibility).")
    public abstract Property<String> getEngineRef();

    private final ExecOperations exec;

    @Inject
    public McTestInitCiTask(ExecOperations exec) {
        this.exec = exec;
    }

    @TaskAction
    public void run() {
        File projectDir = getProjectDir().get().getAsFile();
        File cli = CliSupport.resolveRunnerCli(projectDir, getRunnerCli().isPresent() ? getRunnerCli().get().getAsFile() : null);

        List<String> cmd = new ArrayList<>();
        cmd.add(getNodeExecutable().get());
        cmd.add(cli.getAbsolutePath());
        cmd.add("init-ci");
        cmd.add("--dir");
        cmd.add(projectDir.getAbsolutePath());
        if (getStandalone().getOrElse(false)) {
            cmd.add("--standalone");
        }
        if (getAgents().isPresent()) {
            cmd.add("--agents");
            cmd.add(getAgents().get());
        }
        if (getBuildCommand().isPresent()) {
            cmd.add("--build-command");
            cmd.add(getBuildCommand().get());
        }
        if (getEngineRef().isPresent()) {
            cmd.add("--engine-ref");
            cmd.add(getEngineRef().get());
        }

        getLogger().lifecycle("mc-test: {}", String.join(" ", cmd));
        int code = exec.exec(spec -> {
            spec.commandLine(cmd);
            spec.setWorkingDir(projectDir);
            spec.setIgnoreExitValue(true);
        }).getExitValue();

        if (code != 0) {
            throw new GradleException("mc-test init-ci failed (exit " + code + ").");
        }
    }
}
