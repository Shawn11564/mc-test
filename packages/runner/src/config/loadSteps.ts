/**
 * Parse a `*.mctest.yml` step file into the internal `NormalizedTest`. Each
 * step is a single-key mapping `{ <verb>: <args> }`; an `assertPluginState`
 * step's nested `requires` block becomes the step's per-step capability gate.
 */
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { STEP_VERBS, type RequiredCapabilities, type StepVerb } from "@mc-test/protocol";
import type { NormalizedStep, NormalizedTest } from "../model/Step.js";
import type { MatrixCoverage, MatrixDefinition } from "../engine/MatrixExpansion.js";
import { parseAnchors, parseExcept, parseExpect } from "../engine/Invariants.js";

const STEP_VERB_SET = new Set<string>(STEP_VERBS);

function normalizeStep(raw: unknown, index: number, src: string): NormalizedStep {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${src}: step ${index} must be a single-key mapping`);
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length !== 1) {
    throw new Error(
      `${src}: step ${index} must have exactly one verb key (got: ${entries.map((e) => e[0]).join(", ")})`,
    );
  }
  const [verb, value] = entries[0]!;
  if (!STEP_VERB_SET.has(verb)) {
    throw new Error(`${src}: step ${index} has unknown verb '${verb}'`);
  }
  let args: unknown = value;
  let requires: RequiredCapabilities | undefined;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = { ...(value as Record<string, unknown>) };
    if (obj["requires"] && typeof obj["requires"] === "object") {
      requires = obj["requires"] as RequiredCapabilities;
      delete obj["requires"];
    }
    args = obj;
  }
  return { index, verb: verb as StepVerb, args, ...(requires ? { requires } : {}) };
}

/** Parse an already-deserialized step document. */
export function parseStepDocument(doc: unknown, sourceName: string): NormalizedTest {
  if (!doc || typeof doc !== "object") throw new Error(`${sourceName}: not a YAML mapping`);
  const d = doc as Record<string, unknown>;
  const name = String(d["name"] ?? sourceName);
  const requires = (d["requires"] as RequiredCapabilities | undefined) ?? {};
  const optional = d["optional"] as RequiredCapabilities | undefined;
  const matrix = d["matrix"] as MatrixDefinition | undefined;
  const coverage = d["coverage"] as MatrixCoverage | undefined;
  if (coverage !== undefined && coverage !== "full" && coverage !== "pairwise") {
    throw new Error(`${sourceName}: 'coverage' must be 'full' or 'pairwise'`);
  }
  if (matrix !== undefined && (!matrix || typeof matrix !== "object" || Array.isArray(matrix))) {
    throw new Error(`${sourceName}: 'matrix' must be a mapping`);
  }
  const rawSteps = d["steps"];
  if (!Array.isArray(rawSteps)) throw new Error(`${sourceName}: 'steps' must be a list`);
  const steps = rawSteps.map((s, i) => normalizeStep(s, i, sourceName));
  // The §4–§5 invariant: one oracle for every generated case, plus the named
  // positions its clauses refer to. Validated eagerly so a malformed expectation
  // fails at load time rather than passing vacuously mid-matrix.
  const anchors = parseAnchors(d["anchors"], sourceName);
  const expect = parseExpect(d["expect"], sourceName);
  const except = parseExcept(d["except"], sourceName);
  if (except.length && !expect.length) {
    throw new Error(`${sourceName}: 'except' overrides an 'expect' invariant, but none is declared`);
  }
  return {
    name,
    requires,
    ...(optional ? { optional } : {}),
    ...(matrix ? { matrix } : {}),
    ...(coverage ? { coverage } : {}),
    ...(expect.length ? { expect } : {}),
    ...(except.length ? { except } : {}),
    ...(Object.keys(anchors).length ? { anchors } : {}),
    steps,
  };
}

/** Load and parse a `*.mctest.yml` step file. */
export function loadSteps(path: string): NormalizedTest {
  return parseStepDocument(parse(readFileSync(path, "utf8")), path);
}
