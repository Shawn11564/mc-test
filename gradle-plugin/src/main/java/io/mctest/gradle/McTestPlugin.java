package io.mctest.gradle;

import java.util.List;
import org.gradle.api.Plugin;
import org.gradle.api.Project;
import org.gradle.api.plugins.JavaPlugin;
import org.gradle.api.tasks.TaskProvider;
import org.gradle.api.tasks.bundling.Jar;
import org.gradle.language.base.plugins.LifecycleBasePlugin;

/**
 * The mc-test Gradle front door (F6). Applying {@code io.mctest.mc-test} to a
 * Minecraft plugin/mod project registers a {@code mcTest} task that builds the SUT
 * jar and runs mc-test against an ephemeral server — surfaced natively in IntelliJ's
 * Gradle tool window. The Node engine stays the single source of truth; this plugin
 * is a thin front door over it.
 */
public class McTestPlugin implements Plugin<Project> {

    @Override
    public void apply(Project project) {
        McTestExtension ext = project.getExtensions().create("mcTest", McTestExtension.class);
        ext.getMatrix().convention(project.getLayout().getProjectDirectory().file("mc-test.yml"));
        ext.getReportDir().convention(project.getLayout().getBuildDirectory().dir("mc-test-report"));
        ext.getSutJarTask().convention("jar");
        ext.getNodeExecutable().convention("node");
        ext.getAddSpiDependency().convention(true);
        ext.getSpiCoordinates().convention("io.mctest:mc-test-agent-core:0.1.0");
        ext.getWireIntoCheck().convention(false);
        // Default tests: any *.mctest.yml under src/mctest/.
        ext.getTests().from(project.fileTree("src/mctest", t -> t.include("**/*.mctest.yml")));

        // Auto-add the agent-core SPI as compileOnly so SUTs compile against
        // McTestStateProvider / McTestFixtureProvider with no manual dependency wiring.
        project.getPlugins().withType(JavaPlugin.class, jp ->
                project.afterEvaluate(p -> {
                    if (ext.getAddSpiDependency().get()) {
                        p.getDependencies().add("compileOnly", ext.getSpiCoordinates().get());
                    }
                }));

        TaskProvider<McTestRunTask> mcTest = project.getTasks().register("mcTest", McTestRunTask.class, task -> {
            task.setGroup(LifecycleBasePlugin.VERIFICATION_GROUP);
            task.setDescription("Run mc-test step files against an ephemeral Minecraft server.");
            configureCommon(project, ext, task);
        });

        // Item E: reclaim the provisioning workspace (.mc-test/run). `mcTestClean` removes
        // finished/orphaned env dirs; `--all` wipes everything, `--runtime` also clears the
        // shared runtime cache, `--dry-run` reports only.
        project.getTasks().register("mcTestClean", McTestCleanTask.class, task -> {
            task.setGroup(LifecycleBasePlugin.VERIFICATION_GROUP);
            task.setDescription("Reclaim mc-test provisioning workspace (.mc-test/run). [--all] [--runtime] [--dry-run]");
            task.getMatrix().set(ext.getMatrix());
            task.getNodeExecutable().set(ext.getNodeExecutable());
            task.getRunnerCli().set(ext.getRunnerCli());
            task.getProjectDir().set(project.getLayout().getProjectDirectory());
        });

        project.afterEvaluate(p -> {
            // Per-target convenience tasks: mcTest<Target>.
            for (String target : ext.getTargets().getOrElse(List.of())) {
                String name = "mcTest" + capitalize(sanitize(target));
                if (p.getTasks().findByName(name) != null) {
                    continue;
                }
                p.getTasks().register(name, McTestRunTask.class, task -> {
                    task.setGroup(LifecycleBasePlugin.VERIFICATION_GROUP);
                    task.setDescription("Run mc-test step files against target '" + target + "'.");
                    configureCommon(project, ext, task);
                    task.getTargets().set(List.of(target));
                });
            }
            if (ext.getWireIntoCheck().getOrElse(false)) {
                p.getTasks().named(LifecycleBasePlugin.CHECK_TASK_NAME).configure(c -> c.dependsOn(mcTest));
            }
        });
    }

    /** Wire a run task to the build graph: depend on the jar task and consume its output. */
    private static void configureCommon(Project project, McTestExtension ext, McTestRunTask task) {
        String jarTaskName = ext.getSutJarTask().getOrElse("jar");
        TaskProvider<Jar> jarTask = project.getTasks().named(jarTaskName, Jar.class);
        task.dependsOn(jarTask);
        task.getSutJar().set(jarTask.flatMap(Jar::getArchiveFile));
        task.getMatrix().set(ext.getMatrix());
        task.getTests().from(ext.getTests());
        task.getReportDir().set(ext.getReportDir());
        task.getTargets().set(ext.getTargets());
        task.getNodeExecutable().set(ext.getNodeExecutable());
        task.getRunnerCli().set(ext.getRunnerCli());
        task.getProjectDir().set(project.getLayout().getProjectDirectory());
    }

    private static String sanitize(String s) {
        return s.replaceAll("[^A-Za-z0-9]", "");
    }

    private static String capitalize(String s) {
        return s.isEmpty() ? s : Character.toUpperCase(s.charAt(0)) + s.substring(1);
    }
}
