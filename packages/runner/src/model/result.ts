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

/** Per-step outcome within a test. */
export interface StepResult {
  index: number;
  verb: string;
  outcome: Outcome;
  durationMs: number;
  detail?: string;
  skip?: SkipInfo;
  error?: { message: string; reason?: string };
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
}

/** All test results for one (suite × target). */
export interface SuiteResult {
  name: string;
  target: string;
  results: TestResult[];
}
