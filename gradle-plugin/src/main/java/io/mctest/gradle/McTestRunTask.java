package io.mctest.gradle;

import java.io.File;
import java.util.ArrayList;
import java.util.List;
import javax.inject.Inject;
import org.gradle.api.DefaultTask;
import org.gradle.api.GradleException;
import org.gradle.api.file.ConfigurableFileCollection;
import org.gradle.api.file.DirectoryProperty;
import org.gradle.api.file.RegularFileProperty;
import org.gradle.api.provider.ListProperty;
import org.gradle.api.provider.Property;
import org.gradle.api.tasks.Input;
import org.gradle.api.tasks.InputFile;
import org.gradle.api.tasks.InputFiles;
import org.gradle.api.tasks.Internal;
import org.gradle.api.tasks.Optional;
import org.gradle.api.tasks.OutputDirectory;
import org.gradle.api.tasks.PathSensitive;
import org.gradle.api.tasks.PathSensitivity;
import org.gradle.api.tasks.TaskAction;
import org.gradle.process.ExecOperations;
import org.gradle.work.DisableCachingByDefault;

/**
 * Runs the mc-test Node runner against an ephemeral Minecraft server. The freshly
 * built SUT jar (wired from the build graph) is passed via {@code --plugin} so the
 * matrix never hand-references a jar path. JUnit lands under {@link #getReportDir()}
 * where IntelliJ / CI reporters expect it.
 *
 * <p>Not cacheable: the action boots a real (ephemeral) Minecraft server and the only
 * output is a cheap-to-regenerate JUnit report, so a build cache hit would never be
 * trustworthy. The file inputs use content-only ({@code NONE}) path sensitivity — the
 * task re-derives absolute paths at run time, so a file's location does not affect the
 * result. Both annotations are required by Gradle's {@code validatePlugins} check.
 */
@DisableCachingByDefault(because = "Boots an ephemeral Minecraft server; the JUnit report is cheap to regenerate and not worth caching")
public abstract class McTestRunTask extends DefaultTask {

    @InputFile
    @PathSensitive(PathSensitivity.NONE)
    public abstract RegularFileProperty getMatrix();

    @InputFiles
    @PathSensitive(PathSensitivity.NONE)
    public abstract ConfigurableFileCollection getTests();

    /** The SUT jar to test — wired from the project's jar task output by the plugin. */
    @InputFile
    @PathSensitive(PathSensitivity.NONE)
    public abstract RegularFileProperty getSutJar();

    @Input
    public abstract ListProperty<String> getTargets();

    @Input
    public abstract Property<String> getNodeExecutable();

    @Optional
    @InputFile
    @PathSensitive(PathSensitivity.NONE)
    public abstract RegularFileProperty getRunnerCli();

    @OutputDirectory
    public abstract DirectoryProperty getReportDir();

    /** Project dir — the runner's working directory + the root of CLI auto-detection. */
    @Internal
    public abstract DirectoryProperty getProjectDir();

    private final ExecOperations exec;

    @Inject
    public McTestRunTask(ExecOperations exec) {
        this.exec = exec;
    }

    @TaskAction
    public void run() {
        File projectDir = getProjectDir().get().getAsFile();
        File cli = resolveRunnerCli(projectDir);

        List<File> tests = new ArrayList<>(getTests().getFiles());
        if (tests.isEmpty()) {
            throw new GradleException(
                    "mcTest: no step files configured. Put *.mctest.yml under src/mctest/, "
                            + "or set mcTest { tests.from(\"path/to/test.mctest.yml\") }.");
        }

        File matrix = getMatrix().get().getAsFile();
        File jar = getSutJar().get().getAsFile();
        File outDir = getReportDir().get().getAsFile();

        List<String> cmd = new ArrayList<>();
        cmd.add(getNodeExecutable().get());
        cmd.add(cli.getAbsolutePath());
        cmd.add("run");
        for (File t : tests) {
            cmd.add(t.getAbsolutePath());
        }
        cmd.add("--matrix");
        cmd.add(matrix.getAbsolutePath());
        List<String> targets = getTargets().getOrElse(List.of());
        if (!targets.isEmpty()) {
            cmd.add("--target");
            cmd.add(String.join(",", targets));
        }
        cmd.add("--plugin");
        cmd.add(jar.getAbsolutePath());
        cmd.add("--out");
        cmd.add(outDir.getAbsolutePath());

        getLogger().lifecycle("mc-test: {}", String.join(" ", cmd));
        int code = exec.exec(spec -> {
            spec.commandLine(cmd);
            spec.setWorkingDir(projectDir);
            spec.setIgnoreExitValue(true);
        }).getExitValue();

        if (code != 0) {
            throw new GradleException(
                    "mc-test reported failures (exit " + code + "). JUnit: "
                            + new File(outDir, "junit/results.xml").getAbsolutePath());
        }
    }

    /** Explicit {@code runnerCli}, else walk up from the project dir for the runner CLI. */
    private File resolveRunnerCli(File projectDir) {
        if (getRunnerCli().isPresent()) {
            File f = getRunnerCli().get().getAsFile();
            if (!f.isFile()) {
                throw new GradleException("mcTest.runnerCli does not exist: " + f);
            }
            return f;
        }
        String[] candidates = {
            "node_modules/@mc-test/runner/dist/cli.js", // installed package (release gate)
            "node_modules/.bin/mc-test",                // bin shim
            "packages/runner/dist/cli.js",              // monorepo dev build
        };
        for (File d = projectDir; d != null; d = d.getParentFile()) {
            for (String c : candidates) {
                File f = new File(d, c);
                if (f.isFile()) {
                    return f;
                }
            }
        }
        throw new GradleException(
                "mc-test runner CLI not found. Set mcTest { runnerCli = file(\"…/dist/cli.js\") }, "
                        + "install @mc-test/runner, or build it in this monorepo "
                        + "(npm run build -w @mc-test/runner).");
    }
}
