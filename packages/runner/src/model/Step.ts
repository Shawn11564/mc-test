/**
 * The normalized internal step/test model. Both authoring surfaces (YAML
 * `*.mctest.yml` and the fluent API) compile to a `NormalizedTest` so the
 * engine runs them identically.
 */
import type { RequiredCapabilities, StepVerb } from "@mc-test/protocol";
import type { MatrixCoverage, MatrixDefinition } from "../engine/MatrixExpansion.js";
import type { ExceptEntry, ExpectBranch, InvariantAnnotation, Vec3 } from "../engine/Invariants.js";

/** One normalized step: a canonical verb + its argument bag + optional per-step caps. */
export interface NormalizedStep {
  index: number;
  verb: StepVerb;
  /**
   * The verb's argument value — an object (`{ label: "Regions" }`) or a bare
   * string shorthand (`command: "or"`, `click: "Regions"`).
   */
  args: unknown;
  /** Per-step required capabilities (e.g. assertPluginState → `{ pluginState: true }`). */
  requires?: RequiredCapabilities;
  /**
   * Set on steps compiled from the `expect:` invariant DSL (§4–§5): this step IS
   * the oracle, not a scripted action. The runner reports its verdict as the
   * case's `expected`/`actual`/`invariant_ref`, classifies its failure as `fail`
   * (an expectation broke) rather than `error`, and turns a capability skip here
   * into a case skip — an unevaluated invariant is never a pass.
   */
  invariant?: InvariantAnnotation;
}

/** A test compiled to the internal model. */
export interface NormalizedTest {
  name: string;
  requires: RequiredCapabilities;
  optional?: RequiredCapabilities;
  steps: NormalizedStep[];
  /** §4 matrix declaration, present only on parameterized test files. */
  matrix?: MatrixDefinition;
  coverage?: MatrixCoverage;
  /** §4–§5 invariant: the shared oracle every generated case is judged against. */
  expect?: ExpectBranch[];
  /** §4 per-case overrides of that oracle — allowed, always flagged in results.json. */
  except?: ExceptEntry[];
  /** Named positions `expect:` clauses refer to (`pos: "chest + $face"`). */
  anchors?: Record<string, Vec3>;
  /** Concrete case identity after matrix expansion (not authored directly). */
  matrixCase?: {
    id: string;
    config: Record<string, unknown>;
    coverage: MatrixCoverage;
    environmentKey: string;
    setup: Array<{ action: string; dimension: string; value: unknown }>;
  };
}
