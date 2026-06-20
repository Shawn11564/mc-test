package io.mctest.gradle;

import java.io.File;
import org.gradle.api.GradleException;

/** Shared helpers for locating the mc-test Node runner CLI (used by the run + clean tasks). */
final class CliSupport {

    private CliSupport() {}

    /**
     * Resolve the runner's {@code cli.js}: an explicit {@code mcTest.runnerCli} when set, else
     * walk up from the project dir for an installed package, a {@code .bin} shim, or a monorepo
     * dev build. Mirrors the lookup the run task has always used, so {@code mcTestClean} finds the
     * same CLI {@code mcTest} does.
     */
    static File resolveRunnerCli(File projectDir, File explicitCli) {
        if (explicitCli != null) {
            if (!explicitCli.isFile()) {
                throw new GradleException("mcTest.runnerCli does not exist: " + explicitCli);
            }
            return explicitCli;
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
