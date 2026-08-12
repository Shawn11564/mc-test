/**
 * `mc-test validate --against-commit <sha>` — the lab controls from spec
 * commandcenter/40-testing-loop.md §5.
 *
 * An invariant nobody has falsified is not yet an oracle. §5 asks for two runs:
 *
 *  - **positive control** — against a known-GOOD build, everything must be green,
 *    or the invariant is too strict / mistranslated. (`validate` with no
 *    `--expect-fail`.)
 *  - **negative control** — against a known-BAD commit, it must go red on exactly
 *    the bad combinations. Git history supplies real mutants, so this is
 *    automatable: check the sha out in a worktree, build it, and run TODAY's
 *    check against YESTERDAY's code. (`--expect-fail`.)
 *
 * The direction matters: the check file comes from the working tree, the SUT from
 * the worktree. Running the old commit's own tests against the old commit would
 * prove nothing about the invariant you just wrote.
 *
 * A control that cannot demonstrate anything is a FAILED control here — a skipped
 * case, or a run where nothing executed, exits non-zero rather than shrugging.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ResultCase, ResultsReport } from "../report/ResultsReporter.js";

export interface ValidateOptions {
  /** The commit to judge (any git rev: sha, tag, branch). */
  sha: string;
  /** Repo holding that commit (default: cwd). */
  repo: string;
  /** Negative control: the run MUST go red. Absent → positive control (must be green). */
  expectFail: boolean;
  /**
   * `dim=value[,dim=value]` — the combinations expected to go red. Every matching
   * case must fail AND every non-matching case must pass, which is what "red on
   * exactly the bad combinations" means. Absent → any red case satisfies it.
   */
  expectCases?: string;
  /** Build command to run in the worktree (default: detected from the checkout). */
  build?: string;
  /** Built artifact to test, relative to the worktree (default: detected). */
  artifact?: string;
  /** Keep the worktree for inspection instead of removing it. */
  keep?: boolean;
}

export interface ValidationVerdict {
  ok: boolean;
  reason: string;
  red: string[];
  green: string[];
  skipped: string[];
  /** Cases that went red but were not expected to (negative control only). */
  unexpectedRed: string[];
  /** Cases that were expected to go red and did not. */
  missingRed: string[];
}

/** Parse `held=sign-item,neighbor=occupied` into the config subset it demands. */
export function parseCaseSelector(selector: string): Record<string, string> {
  const wanted: Record<string, string> = {};
  for (const part of selector.split(",").map((s) => s.trim()).filter(Boolean)) {
    const at = part.indexOf("=");
    if (at <= 0) throw new Error(`--expect-cases: '${part}' must be <dimension>=<value>`);
    wanted[part.slice(0, at).trim()] = part.slice(at + 1).trim();
  }
  if (!Object.keys(wanted).length) throw new Error("--expect-cases needs at least one <dimension>=<value>");
  return wanted;
}

const matchesSelector = (c: ResultCase, wanted: Record<string, string>): boolean =>
  Object.entries(wanted).every(
    ([key, value]) => String(c.config[key] ?? "").trim().toLowerCase() === value.trim().toLowerCase(),
  );

/**
 * Decide whether the control behaved as claimed. Pure — the CLI plumbing around
 * it (worktree, build, run) is what the integration test exercises separately.
 */
export function decideValidation(report: ResultsReport, opts: Pick<ValidateOptions, "expectFail" | "expectCases">): ValidationVerdict {
  const isRed = (c: ResultCase): boolean => c.status === "fail" || c.status === "error";
  const red = report.cases.filter(isRed).map((c) => c.id);
  const green = report.cases.filter((c) => c.status === "pass").map((c) => c.id);
  const skipped = report.cases.filter((c) => c.status === "skip").map((c) => c.id);
  const base: ValidationVerdict = { ok: false, reason: "", red, green, skipped, unexpectedRed: [], missingRed: [] };

  if (report.cases.length === 0) {
    return { ...base, reason: "the run produced no cases at all — nothing was controlled" };
  }
  if (report.executed === 0) {
    return {
      ...base,
      reason: `no case EXECUTED (${skipped.length} skipped) — a control that never ran proves nothing${
        skipped.length ? `: ${skipped[0]}` : ""
      }`,
    };
  }

  if (!opts.expectFail) {
    // Positive control: a known-good build must be entirely green.
    if (red.length) {
      return { ...base, reason: `positive control FAILED: ${red.length} case(s) went red on a build expected to be green — ${red.join(", ")}` };
    }
    if (skipped.length) {
      return { ...base, reason: `positive control INCONCLUSIVE: ${skipped.length} case(s) skipped, so they proved nothing — ${skipped.join(", ")}` };
    }
    return { ...base, ok: true, reason: `positive control held: all ${green.length} case(s) green` };
  }

  if (!opts.expectCases) {
    if (!red.length) {
      return {
        ...base,
        reason:
          `negative control FAILED: --expect-fail demanded red, but all ${report.executed} executed case(s) passed. ` +
          `Either the commit is not the mutant you think it is, or the invariant does not catch it.`,
      };
    }
    return { ...base, ok: true, reason: `negative control held: ${red.length} of ${report.executed} executed case(s) went red` };
  }

  const wanted = parseCaseSelector(opts.expectCases);
  const selected = report.cases.filter((c) => matchesSelector(c, wanted));
  if (!selected.length) {
    return { ...base, reason: `--expect-cases '${opts.expectCases}' matched none of the ${report.cases.length} case(s) — check the dimension names/values` };
  }
  const missingRed = selected.filter((c) => !isRed(c)).map((c) => c.id);
  const unexpectedRed = report.cases.filter((c) => isRed(c) && !matchesSelector(c, wanted)).map((c) => c.id);
  if (missingRed.length || unexpectedRed.length) {
    const parts = [
      missingRed.length ? `${missingRed.length} expected-red case(s) did NOT fail (${missingRed.join(", ")})` : "",
      unexpectedRed.length ? `${unexpectedRed.length} case(s) failed that should not (${unexpectedRed.join(", ")})` : "",
    ].filter(Boolean);
    return { ...base, missingRed, unexpectedRed, reason: `negative control FAILED: ${parts.join("; ")}` };
  }
  return {
    ...base,
    ok: true,
    reason: `negative control held: exactly the ${selected.length} case(s) matching '${opts.expectCases}' went red`,
  };
}

/** Everything that touches the world, injected so the orchestration is testable. */
export interface ValidateDeps {
  /** Build the checked-out worktree (throws on a build failure). */
  build: (worktree: string, command: string) => void;
  /** Run the check(s) against `artifact` and return the parsed report. */
  runCheck: (context: { worktree: string; artifact?: string }) => Promise<ResultsReport>;
  log: (message: string) => void;
}

const git = (args: string[], cwd: string): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/**
 * The build command a checkout implies, when `--build` was not given.
 *
 * The wrapper is named with an explicit `.\` / `./` on both platforms: cmd.exe
 * normally searches the working directory first, but not when
 * `NoDefaultCurrentDirectoryInExePath` is set — which Git Bash sets, and node
 * inherits — so a bare `gradlew.bat` fails with "is not recognized" for anyone
 * who launched the run from a Git Bash shell.
 */
export function detectBuildCommand(worktree: string): string | undefined {
  if (existsSync(join(worktree, "gradlew.bat")) || existsSync(join(worktree, "gradlew"))) {
    return process.platform === "win32" ? ".\\gradlew.bat build -x test" : "./gradlew build -x test";
  }
  if (existsSync(join(worktree, "pom.xml"))) return "mvn -B -DskipTests package";
  return undefined;
}

/** Jars that are not the SUT: sources/javadoc bundles and shade's pre-relocation copy. */
const NOT_THE_SUT = /(-sources|-javadoc|-dev|-slim)\.jar$|^original-/i;

/** Find the built artifact in a worktree (gradle `build/libs`, maven `target`). */
export function detectArtifact(worktree: string): string | undefined {
  for (const dir of [join(worktree, "build", "libs"), join(worktree, "target")]) {
    if (!existsSync(dir)) continue;
    const jars = readdirSync(dir).filter((f) => f.endsWith(".jar") && !NOT_THE_SUT.test(f));
    // Prefer the shortest name: `plugin.jar` over `plugin-all.jar`/`plugin-1.0-shaded.jar`
    // is the usual SUT when a build emits several.
    jars.sort((a, b) => a.length - b.length || a.localeCompare(b));
    if (jars.length) return join(dir, jars[0]!);
  }
  return undefined;
}

/**
 * Check the commit out in a worktree, build it, run the check against it, and
 * judge the control. Returns a process exit code: 0 = the control behaved as
 * claimed, 1 = it did not, 2 = the control could not be set up at all.
 */
export async function runValidation(
  opts: ValidateOptions,
  deps: ValidateDeps,
): Promise<{ code: number; verdict?: ValidationVerdict }> {
  const repo = resolve(opts.repo);
  let sha: string;
  try {
    sha = git(["rev-parse", "--verify", `${opts.sha}^{commit}`], repo);
  } catch {
    deps.log(`validate: '${opts.sha}' is not a commit in ${repo} (fetch it, or pass --repo)`);
    return { code: 2 };
  }
  const short = sha.slice(0, 12);
  const worktree = join(repo, ".mc-test", "validate", short);
  // A worktree left by an interrupted earlier run would make `add` fail; clear it.
  if (existsSync(worktree)) {
    try {
      git(["worktree", "remove", "--force", worktree], repo);
    } catch {
      rmSync(worktree, { recursive: true, force: true });
    }
  }

  deps.log(`validate: checking out ${short} in ${worktree}`);
  try {
    git(["worktree", "add", "--detach", "--force", worktree, sha], repo);
  } catch (err) {
    deps.log(`validate: could not create a worktree at ${short}: ${err instanceof Error ? err.message : String(err)}`);
    return { code: 2 };
  }

  try {
    const command = opts.build ?? detectBuildCommand(worktree);
    if (!command) {
      deps.log(
        `validate: no build detected in ${short} (no gradlew, no pom.xml) — pass --build "<command>" so the mutant is actually built`,
      );
      return { code: 2 };
    }
    deps.log(`validate: building ${short} — ${command}`);
    try {
      deps.build(worktree, command);
    } catch (err) {
      deps.log(`validate: building ${short} failed: ${err instanceof Error ? err.message : String(err)}`);
      return { code: 2 };
    }

    const artifact = opts.artifact ? resolve(worktree, opts.artifact) : detectArtifact(worktree);
    if (opts.artifact && !existsSync(artifact!)) {
      deps.log(`validate: --artifact ${opts.artifact} does not exist in the built worktree`);
      return { code: 2 };
    }
    if (!artifact) {
      deps.log(`validate: no built jar found in ${short} (looked in build/libs and target) — pass --artifact <path>`);
      return { code: 2 };
    }
    deps.log(`validate: running the check against ${artifact}`);

    const report = await deps.runCheck({ worktree, artifact });
    const verdict = decideValidation(report, opts);
    deps.log("");
    deps.log(
      `${verdict.ok ? "✓" : "✗"} ${verdict.reason}\n` +
        `  commit:  ${short}\n` +
        `  cases:   ${report.cases.length} declared-executed ${report.executed}, red ${verdict.red.length}, green ${verdict.green.length}, skipped ${verdict.skipped.length}`,
    );
    return { code: verdict.ok ? 0 : 1, verdict };
  } finally {
    if (opts.keep) {
      deps.log(`validate: keeping the worktree at ${worktree} (--keep)`);
    } else {
      try {
        git(["worktree", "remove", "--force", worktree], repo);
      } catch {
        // A build can leave file handles open (Windows); a leftover directory is
        // untidy but must never change the control's verdict.
        rmSync(worktree, { recursive: true, force: true });
        try {
          git(["worktree", "prune"], repo);
        } catch {
          /* best effort */
        }
      }
    }
  }
}
