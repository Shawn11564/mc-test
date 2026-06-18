/**
 * The result model the engine produces and the JUnit reporter consumes.
 */

export type Outcome = "passed" | "failed" | "skipped";

/** A reasoned skip (capability miss, target guard, …). */
export interface SkipInfo {
  category: "capability" | "target" | "environment" | "configuration" | "manual";
  reason: string; // e.g. NO_COMPATIBLE_DRIVER
  unmet: string[];
  message: string;
}

/**
 * Boot-log mod-load detection for a modded server (F5). A SECONDARY, informational
 * signal surfaced in the report; the authoritative proof a mod loaded is the MCTP
 * `mod.loaded` assertion in the test. Defined here (the model layer) so both the
 * provisioner and the reporters reference one type.
 */
export interface ModLoad {
  loader: string;
  /** Mod ids the target declared it expects (`target.expectMods`). */
  expected: string[];
  /** Of `expected`, the ids detected in the boot log. */
  seen: string[];
  /** Of `expected`, the ids NOT detected. */
  missing: string[];
  /** All mod ids parsed from the log (best-effort; richest on Fabric). */
  all: string[];
}

/** An informational, NON-GATING baseline screenshot diff (ROADMAP §5.4 / M4). */
export interface BaselineDiffInfo {
  baselinePath: string;
  /** False when this run only seeded the baseline candidate (no prior baseline). */
  compared: boolean;
  ratio?: number;
  diffPixels?: number;
  totalPixels?: number;
  sameSize?: boolean;
  /** Set when a PNG could not be decoded for comparison. */
  unsupported?: string;
}

/** Per-step outcome within a test. */
export interface StepResult {
  index: number;
  verb: string;
  outcome: Outcome;
  durationMs: number;
  detail?: string;
  skip?: SkipInfo;
  error?: { message: string; reason?: string };
  /**
   * Artifact paths this step produced (absolute) — e.g. a `screenshot` step's
   * persisted PNG. The reporters link these; `collectArtifacts` copies them into
   * the bundle dir even on a passing test.
   */
  artifacts?: string[];
  /** Informational baseline screenshot diff recorded for a `screenshot` step. */
  baselineDiff?: BaselineDiffInfo;
}

/** One authored test resolved against one target. */
export interface TestResult {
  name: string;
  target: string;
  loader?: string;
  mc?: string;
  driver?: string;
  outcome: Outcome;
  durationMs: number;
  steps: StepResult[];
  skip?: SkipInfo;
  failure?: { message: string; type: string };
  systemOut?: string;
  artifacts?: string[];
  /**
   * The selected driver advertised the advisory `brittle` flag (e.g. the
   * pixel/OCR last-resort driver). The runner sets this and emits a loud report
   * note (`notes`) so a brittle result is never mistaken for a reliable one
   * (ROADMAP §6.3). Advisory only — it does not affect outcome.
   */
  brittle?: boolean;
  /** Loud, human-facing report notes (e.g. the brittle-driver warning). */
  notes?: string[];
  /** Boot-log mod-load detection for a modded-server target (F5). */
  modLoad?: ModLoad;
}

/** All test results for one (suite × target). */
export interface SuiteResult {
  name: string;
  target: string;
  results: TestResult[];
}
