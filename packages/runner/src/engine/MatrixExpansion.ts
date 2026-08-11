/**
 * Test-file matrix expansion (spec 40-testing-loop.md §4).
 *
 * A case is a complete, concrete configuration.  This module deliberately has
 * no runner or MCTP dependency: it makes expansion deterministic and gives the
 * CLI a small, testable unit to schedule (and later group by environment).
 */
import type { NormalizedStep, NormalizedTest } from "../model/Step.js";

export type MatrixCoverage = "full" | "pairwise";

export interface MatrixBinding {
  /** Set `param` on every authored step whose verb is `step`. */
  step?: string;
  param?: string;
  /** Named setup action; retained on the concrete case for the setup executor. */
  setup?: string;
  /** Provisioning/environment variant; cases with the same values share a boot. */
  environment?: string;
}

export interface MatrixDimension {
  values: unknown[] | Record<string, unknown>;
  bind?: MatrixBinding;
}

export type MatrixDefinition = Record<string, MatrixDimension>;

export interface MatrixCase {
  /** Stable, readable identity, e.g. `face=north,held=empty`. */
  id: string;
  /** Values written to results.json. Map-form dimensions use their symbolic key. */
  config: Record<string, unknown>;
  /** Concrete values used for `$dimension` substitution and parameter binding. */
  values: Record<string, unknown>;
  coverage: MatrixCoverage;
  /** Stable key for server-boot grouping. Empty means the default environment. */
  environmentKey: string;
  /** Deferred setup-action bindings, in authored dimension order. */
  setup: Array<{ action: string; dimension: string; value: unknown }>;
  test: NormalizedTest;
}

interface Option {
  label: string;
  value: unknown;
}

interface DimensionOptions {
  name: string;
  bind?: MatrixBinding;
  options: Option[];
}

function stringify(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function optionsFor(name: string, dimension: MatrixDimension): DimensionOptions {
  if (!dimension || !Array.isArray(dimension.values) && (typeof dimension.values !== "object" || dimension.values === null)) {
    throw new Error(`matrix dimension '${name}' needs a values list or mapping`);
  }
  const options = Array.isArray(dimension.values)
    ? dimension.values.map((value) => ({ label: stringify(value), value }))
    : Object.entries(dimension.values).map(([label, value]) => ({ label, value }));
  if (options.length === 0) throw new Error(`matrix dimension '${name}' has no values`);
  return { name, bind: dimension.bind, options };
}

function fullCombinations(dimensions: DimensionOptions[]): Option[][] {
  return dimensions.reduce<Option[][]>((acc, dimension) =>
    acc.flatMap((prefix) => dimension.options.map((option) => [...prefix, option])), [[]]);
}

/** Select a deterministic, greedy pairwise covering subset of the full product. */
function pairwiseCombinations(dimensions: DimensionOptions[]): Option[][] {
  const all = fullCombinations(dimensions);
  if (dimensions.length < 3) return all;

  const uncovered = new Set<string>();
  for (let left = 0; left < dimensions.length; left++) {
    for (let right = left + 1; right < dimensions.length; right++) {
      for (const a of dimensions[left]!.options) {
        for (const b of dimensions[right]!.options) uncovered.add(`${left}:${a.label}|${right}:${b.label}`);
      }
    }
  }
  const pairsOf = (combination: Option[]) => {
    const pairs: string[] = [];
    for (let left = 0; left < combination.length; left++) {
      for (let right = left + 1; right < combination.length; right++) {
        pairs.push(`${left}:${combination[left]!.label}|${right}:${combination[right]!.label}`);
      }
    }
    return pairs;
  };

  const selected: Option[][] = [];
  const candidates = [...all];
  while (uncovered.size) {
    let best = 0;
    let score = -1;
    for (let i = 0; i < candidates.length; i++) {
      const covered = pairsOf(candidates[i]!).filter((pair) => uncovered.has(pair)).length;
      if (covered > score) { score = covered; best = i; }
    }
    // Every uncovered pair occurs in a full-product candidate; this is only a
    // defensive guard for future changes to the candidate generator.
    if (score <= 0) break;
    const chosen = candidates.splice(best, 1)[0]!;
    selected.push(chosen);
    for (const pair of pairsOf(chosen)) uncovered.delete(pair);
  }
  return selected;
}

function substitute(value: unknown, bindings: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    const exact = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(value);
    if (exact) return exact[1]! in bindings ? bindings[exact[1]!] : value;
    return value.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (token, name: string) =>
      name in bindings ? stringify(bindings[name]) : token,
    );
  }
  if (Array.isArray(value)) return value.map((entry) => substitute(entry, bindings));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, substitute(entry, bindings)]));
  }
  return value;
}

function materializeSteps(
  steps: NormalizedStep[],
  dimensions: DimensionOptions[],
  values: Record<string, unknown>,
): NormalizedStep[] {
  const concrete = steps.map((step) => {
    const args = substitute(step.args, values);
    const bound = dimensions.filter((dimension) => dimension.bind?.step === step.verb && dimension.bind.param);
    if (!bound.length || !args || typeof args !== "object" || Array.isArray(args)) return { ...step, args };
    const withParams = { ...(args as Record<string, unknown>) };
    for (const dimension of bound) withParams[dimension.bind!.param!] = values[dimension.name];
    return { ...step, args: withParams };
  });
  // Case mechanics: establish fixture isolation before setup and test steps. A
  // missing fixture provider is represented as the runner's honest step skip.
  const setupSteps = dimensions
    .filter((dimension) => dimension.bind?.setup)
    .map((dimension, i) => ({
      index: -2 - i,
      verb: "fixture" as const,
      args: { name: dimension.bind!.setup!, args: { [dimension.name]: values[dimension.name] } },
      requires: { fixtures: true },
    }));
  return [
    { index: -1, verb: "fixture", args: { reset: true }, requires: { fixtures: true } },
    ...setupSteps,
    ...concrete,
  ];
}

/** Expand a parameterized test into its declared full or pairwise cases. */
export function expandMatrix(test: NormalizedTest): MatrixCase[] {
  const definition = test.matrix;
  if (!definition || Object.keys(definition).length === 0) return [];
  const dimensions = Object.entries(definition).map(([name, dimension]) => optionsFor(name, dimension));
  const coverage = test.coverage ?? "full";
  if (coverage !== "full" && coverage !== "pairwise") throw new Error(`coverage must be 'full' or 'pairwise'`);
  const combinations = coverage === "full" ? fullCombinations(dimensions) : pairwiseCombinations(dimensions);

  return combinations.map((combination) => {
    const values = Object.fromEntries(dimensions.map((dimension, i) => [dimension.name, combination[i]!.value]));
    const config = Object.fromEntries(dimensions.map((dimension, i) => [dimension.name, combination[i]!.label]));
    const id = dimensions.map((dimension, i) => `${dimension.name}=${combination[i]!.label}`).join(",");
    const environment = dimensions
      .filter((dimension) => dimension.bind?.environment)
      .map((dimension, i) => `${dimension.bind!.environment}=${stringify(values[dimension.name])}`);
    const setup = dimensions
      .filter((dimension) => dimension.bind?.setup)
      .map((dimension) => ({ action: dimension.bind!.setup!, dimension: dimension.name, value: values[dimension.name] }));
    return {
      id,
      config,
      values,
      coverage,
      environmentKey: environment.join(","),
      setup,
      test: {
        ...test,
        steps: materializeSteps(test.steps, dimensions, values),
        matrixCase: { id, config, coverage, environmentKey: environment.join(","), setup },
      },
    };
  });
}
