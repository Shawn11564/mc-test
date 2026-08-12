/**
 * `mc-test validate --against-commit` — the §5 lab controls.
 *
 * Two layers, deliberately: the VERDICT logic is pure and exhaustively tested
 * (including the acceptance case — a green run under `--expect-fail` must exit
 * non-zero), and the ORCHESTRATION is tested against a real temporary git repo
 * with two real commits, so the worktree checkout, the build hand-off and the
 * cleanup are proved rather than mocked away. Only the build command and the
 * mc-test run itself are injected — booting a server per assertion would make
 * this suite untestable, and those two seams are exercised for real by the
 * ChestShop proof (spec §10 Plan D step 4).
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decideValidation,
  detectArtifact,
  detectBuildCommand,
  parseCaseSelector,
  runValidation,
  type ResultsReport,
} from "../src/index.js";

/** A results.json with the given per-case statuses + configs. */
function report(cases: Array<{ id: string; status: "pass" | "fail" | "error" | "skip"; config?: Record<string, unknown> }>): ResultsReport {
  const of = (s: string) => cases.filter((c) => c.status === s).length;
  return {
    declared: cases.length,
    executed: of("pass") + of("fail") + of("error"),
    passed: of("pass"),
    failed: of("fail"),
    errored: of("error"),
    skipped: of("skip"),
    coverage_model: "full",
    target: "paper-1.20.4",
    cases: cases.map((c) => ({ id: c.id, config: c.config ?? {}, status: c.status, ms: 1, evidence: [] })),
  };
}

const PLACEMENT = report([
  { id: "p[held=sign,neighbor=free]@t", status: "pass", config: { held: "sign", neighbor: "free" } },
  { id: "p[held=sign,neighbor=occupied]@t", status: "pass", config: { held: "sign", neighbor: "occupied" } },
  { id: "p[held=block,neighbor=free]@t", status: "pass", config: { held: "block", neighbor: "free" } },
  { id: "p[held=block,neighbor=occupied]@t", status: "fail", config: { held: "block", neighbor: "occupied" } },
]);

describe("§5 negative control (--expect-fail)", () => {
  it("FAILS a green run — the whole point of a negative control", () => {
    const verdict = decideValidation(report([{ id: "a", status: "pass" }, { id: "b", status: "pass" }]), {
      expectFail: true,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("demanded red, but all 2 executed case(s) passed");
  });

  it("holds when any case goes red and no combinations were named", () => {
    const verdict = decideValidation(report([{ id: "a", status: "pass" }, { id: "b", status: "fail" }]), {
      expectFail: true,
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.red).toEqual(["b"]);
  });

  it("counts an `error` as red — the mutant may break the step, not just the expectation", () => {
    expect(decideValidation(report([{ id: "a", status: "error" }]), { expectFail: true }).ok).toBe(true);
  });

  it("holds when EXACTLY the named combinations go red", () => {
    const verdict = decideValidation(PLACEMENT, { expectFail: true, expectCases: "held=block,neighbor=occupied" });
    expect(verdict.ok).toBe(true);
    expect(verdict.reason).toContain("exactly the 1 case(s)");
  });

  it("fails when a named combination stayed green (the mutant did not reproduce)", () => {
    const allGreen = report(PLACEMENT.cases.map((c) => ({ id: c.id, status: "pass" as const, config: c.config })));
    const verdict = decideValidation(allGreen, { expectFail: true, expectCases: "held=block,neighbor=occupied" });
    expect(verdict.ok).toBe(false);
    expect(verdict.missingRed).toEqual(["p[held=block,neighbor=occupied]@t"]);
  });

  it("fails when a case outside the named combinations ALSO went red (over-broad damage)", () => {
    const extra = report([
      ...PLACEMENT.cases.map((c) => ({ id: c.id, status: c.status as "pass" | "fail", config: c.config })),
    ]);
    extra.cases[0]!.status = "fail";
    const verdict = decideValidation(extra, { expectFail: true, expectCases: "held=block,neighbor=occupied" });
    expect(verdict.ok).toBe(false);
    expect(verdict.unexpectedRed).toEqual(["p[held=sign,neighbor=free]@t"]);
  });

  it("rejects a selector that matches nothing rather than declaring victory", () => {
    const verdict = decideValidation(PLACEMENT, { expectFail: true, expectCases: "held=lava" });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("matched none of the 4 case(s)");
  });

  it("fails a run where nothing executed — a control that never ran proves nothing", () => {
    const verdict = decideValidation(report([{ id: "a", status: "skip" }]), { expectFail: true });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("no case EXECUTED");
  });
});

describe("§5 positive control (no --expect-fail)", () => {
  it("holds when a known-good build is entirely green", () => {
    const verdict = decideValidation(report([{ id: "a", status: "pass" }]), { expectFail: false });
    expect(verdict.ok).toBe(true);
    expect(verdict.reason).toContain("all 1 case(s) green");
  });

  it("fails on any red — the invariant is too strict or mistranslated", () => {
    const verdict = decideValidation(report([{ id: "a", status: "pass" }, { id: "b", status: "fail" }]), {
      expectFail: false,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("positive control FAILED");
  });

  it("calls a partially-skipped run INCONCLUSIVE rather than green", () => {
    const verdict = decideValidation(report([{ id: "a", status: "pass" }, { id: "b", status: "skip" }]), {
      expectFail: false,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("INCONCLUSIVE");
  });
});

describe("§5 selector + build/artifact detection", () => {
  it("parses dim=value pairs and rejects malformed ones", () => {
    expect(parseCaseSelector("held=block, neighbor=occupied")).toEqual({ held: "block", neighbor: "occupied" });
    expect(() => parseCaseSelector("held")).toThrow(/must be <dimension>=<value>/);
    expect(() => parseCaseSelector("")).toThrow(/at least one/);
  });

  it("detects gradle and maven builds, and admits when it cannot", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-test-detect-"));
    expect(detectBuildCommand(dir)).toBeUndefined();
    writeFileSync(join(dir, "pom.xml"), "<project/>");
    expect(detectBuildCommand(dir)).toBe("mvn -B -DskipTests package");
    writeFileSync(join(dir, "gradlew.bat"), "");
    expect(detectBuildCommand(dir)).toContain("gradlew");
  });

  it("finds the built jar and ignores sources/javadoc/shade leftovers", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-test-artifact-"));
    mkdirSync(join(dir, "build", "libs"), { recursive: true });
    for (const name of ["sut-1.0-sources.jar", "sut-1.0-javadoc.jar", "sut-1.0-all.jar", "sut-1.0.jar"]) {
      writeFileSync(join(dir, "build", "libs", name), "");
    }
    expect(detectArtifact(dir)).toBe(join(dir, "build", "libs", "sut-1.0.jar"));
  });
});

/** A throwaway repo with a "good" commit and a "mutant" commit. */
function fixtureRepo(): { dir: string; good: string; mutant: string } {
  const dir = mkdtempSync(join(tmpdir(), "mc-test-validate-repo-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "mc-test");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "pom.xml"), "<project/>");
  writeFileSync(join(dir, "sut.txt"), "correct\n");
  git("add", "-A");
  git("commit", "-qm", "good");
  const good = git("rev-parse", "HEAD");
  writeFileSync(join(dir, "sut.txt"), "mutant\n");
  git("add", "-A");
  git("commit", "-qm", "mutant: pick the wrong item");
  const mutant = git("rev-parse", "HEAD");
  // The working tree is left at the mutant commit; validate must not care.
  return { dir, good, mutant };
}

describe("§5 validate orchestration (real git worktree)", () => {
  it("checks the sha out in a worktree, builds it there, and removes it afterwards", async () => {
    const { dir, good, mutant } = fixtureRepo();
    let builtIn: string | undefined;
    let sawContent: string | undefined;
    let ranAgainst: string | undefined;

    const { code, verdict } = await runValidation(
      { sha: good, repo: dir, expectFail: true, keep: false },
      {
        build: (worktree) => {
          builtIn = worktree;
          // Proof the checkout is at the REQUESTED commit, not the working tree.
          sawContent = readFileSync(join(worktree, "sut.txt"), "utf8").trim();
          mkdirSync(join(worktree, "target"), { recursive: true });
          writeFileSync(join(worktree, "target", "sut.jar"), "");
        },
        runCheck: async ({ artifact }) => {
          ranAgainst = artifact;
          return report([{ id: "a", status: "fail" }]);
        },
        log: () => {},
      },
    );

    expect(sawContent).toBe("correct");
    expect(readFileSync(join(dir, "sut.txt"), "utf8").trim()).toBe("mutant"); // working tree untouched
    expect(ranAgainst).toBe(join(builtIn!, "target", "sut.jar"));
    expect(code).toBe(0);
    expect(verdict!.ok).toBe(true);
    expect(existsSync(builtIn!)).toBe(false); // worktree cleaned up
    expect(mutant).not.toBe(good);
  });

  it("EXITS NON-ZERO when --expect-fail meets a green run", async () => {
    const { dir, mutant } = fixtureRepo();
    const { code, verdict } = await runValidation(
      { sha: mutant, repo: dir, expectFail: true },
      {
        build: (worktree) => {
          mkdirSync(join(worktree, "target"), { recursive: true });
          writeFileSync(join(worktree, "target", "sut.jar"), "");
        },
        runCheck: async () => report([{ id: "a", status: "pass" }, { id: "b", status: "pass" }]),
        log: () => {},
      },
    );
    expect(code).toBe(1);
    expect(verdict!.ok).toBe(false);
    expect(verdict!.reason).toContain("negative control FAILED");
  });

  it("keeps the worktree when asked, and can be re-run over a leftover one", async () => {
    const { dir, good } = fixtureRepo();
    const deps = {
      build: (worktree: string) => {
        mkdirSync(join(worktree, "target"), { recursive: true });
        writeFileSync(join(worktree, "target", "sut.jar"), "");
      },
      runCheck: async () => report([{ id: "a", status: "fail" }]),
      log: () => {},
    };
    const first = await runValidation({ sha: good, repo: dir, expectFail: true, keep: true }, deps);
    expect(first.code).toBe(0);
    const worktree = join(dir, ".mc-test", "validate", good.slice(0, 12));
    expect(existsSync(worktree)).toBe(true);
    // A second run must reclaim the leftover rather than failing to add it.
    const second = await runValidation({ sha: good, repo: dir, expectFail: true }, deps);
    expect(second.code).toBe(0);
    expect(existsSync(worktree)).toBe(false);
  });

  it("exits 2 (setup failure, not a verdict) for an unknown commit", async () => {
    const { dir } = fixtureRepo();
    const messages: string[] = [];
    const { code, verdict } = await runValidation(
      { sha: "0".repeat(40), repo: dir, expectFail: true },
      { build: () => {}, runCheck: async () => report([]), log: (m) => messages.push(m) },
    );
    expect(code).toBe(2);
    expect(verdict).toBeUndefined();
    expect(messages.join("\n")).toContain("is not a commit");
  });

  it("exits 2 when the checkout has no detectable build, rather than testing nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-test-nobuild-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@e.com");
    git("config", "user.name", "t");
    git("config", "commit.gpgsign", "false");
    writeFileSync(join(dir, "readme.md"), "no build system here");
    git("add", "-A");
    git("commit", "-qm", "only docs");
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();

    const messages: string[] = [];
    const { code } = await runValidation(
      { sha, repo: dir, expectFail: true },
      { build: () => {}, runCheck: async () => report([]), log: (m) => messages.push(m) },
    );
    expect(code).toBe(2);
    expect(messages.join("\n")).toContain("no build detected");
  });
});
