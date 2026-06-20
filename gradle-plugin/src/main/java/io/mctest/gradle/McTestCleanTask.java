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
 * Reclaims the mc-test provisioning workspace by shelling out to {@code mc-test clean}
 * (item E). By default it removes finished/orphaned env dirs under the matrix's
 * {@code workDir} (those whose owning process is gone — the same rule as the runner's
 * startup sweep), leaving a live run's envs alone. Flags widen the scope:
 *
 * <ul>
 *   <li>{@code --all} — remove every env dir, including reuse + live ones;</li>
 *   <li>{@code --runtime} — also clear the shared per-version runtime cache (item D);</li>
 *   <li>{@code --dry-run} — report what would be removed without deleting.</li>
 * </ul>
 *
 * <p>Like the run task, the Node engine stays the single source of truth — this is a
 * thin front door. Never cacheable / never up-to-date: it is a side-effecting cleanup.
 */
@DisableCachingByDefault(because = "Deletes provisioning workspace; a cleanup action is never up-to-date")
public abstract class McTestCleanTask extends DefaultTask {

    @Input
    public abstract Property<String> getNodeExecutable();

    /** Explicit runner {@code cli.js}; auto-detected from the project tree when unset. */
    @Internal
    public abstract RegularFileProperty getRunnerCli();

    /** Matrix file — read for {@code workDir}/{@code cacheDir}; tolerated if absent. */
    @Internal
    public abstract RegularFileProperty getMatrix();

    /** Project dir — the runner's working directory + root of CLI auto-detection. */
    @Internal
    public abstract DirectoryProperty getProjectDir();

    @Input
    @Optional
    @Option(option = "all", description = "Remove EVERY env dir, including reuse dirs and those owned by a live run.")
    public abstract Property<Boolean> getAll();

    @Input
    @Optional
    @Option(option = "runtime", description = "Also clear the shared per-version runtime cache (libraries/cache/versions).")
    public abstract Property<Boolean> getRuntime();

    @Input
    @Optional
    @Option(option = "dry-run", description = "Report what would be removed without deleting anything.")
    public abstract Property<Boolean> getDryRun();

    private final ExecOperations exec;

    @Inject
    public McTestCleanTask(ExecOperations exec) {
        this.exec = exec;
    }

    @TaskAction
    public void run() {
        File projectDir = getProjectDir().get().getAsFile();
        File cli = CliSupport.resolveRunnerCli(projectDir, getRunnerCli().isPresent() ? getRunnerCli().get().getAsFile() : null);

        List<String> cmd = new ArrayList<>();
        cmd.add(getNodeExecutable().get());
        cmd.add(cli.getAbsolutePath());
        cmd.add("clean");
        if (getMatrix().isPresent() && getMatrix().get().getAsFile().isFile()) {
            cmd.add("--matrix");
            cmd.add(getMatrix().get().getAsFile().getAbsolutePath());
        }
        if (getAll().getOrElse(false)) {
            cmd.add("--all");
        }
        if (getRuntime().getOrElse(false)) {
            cmd.add("--runtime");
        }
        if (getDryRun().getOrElse(false)) {
            cmd.add("--dry-run");
        }

        getLogger().lifecycle("mc-test: {}", String.join(" ", cmd));
        int code = exec.exec(spec -> {
            spec.commandLine(cmd);
            spec.setWorkingDir(projectDir);
            spec.setIgnoreExitValue(true);
        }).getExitValue();

        if (code != 0) {
            throw new GradleException("mc-test clean failed (exit " + code + ").");
        }
    }
}
