/**
 * The normalized internal step/test model. Both authoring surfaces (YAML
 * `*.mctest.yml` and the fluent API) compile to a `NormalizedTest` so the
 * engine runs them identically.
 */
import type { RequiredCapabilities, StepVerb } from "@mc-test/protocol";

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
}

/** A test compiled to the internal model. */
export interface NormalizedTest {
  name: string;
  requires: RequiredCapabilities;
  optional?: RequiredCapabilities;
  steps: NormalizedStep[];
}
