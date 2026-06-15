/**
 * Parse a `*.mctest.yml` step file into the internal `NormalizedTest`. Each
 * step is a single-key mapping `{ <verb>: <args> }`; an `assertPluginState`
 * step's nested `requires` block becomes the step's per-step capability gate.
 */
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { STEP_VERBS, type RequiredCapabilities, type StepVerb } from "@mc-test/protocol";
import type { NormalizedStep, NormalizedTest } from "../model/Step.js";

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
  const rawSteps = d["steps"];
  if (!Array.isArray(rawSteps)) throw new Error(`${sourceName}: 'steps' must be a list`);
  const steps = rawSteps.map((s, i) => normalizeStep(s, i, sourceName));
  return { name, requires, ...(optional ? { optional } : {}), steps };
}

/** Load and parse a `*.mctest.yml` step file. */
export function loadSteps(path: string): NormalizedTest {
  return parseStepDocument(parse(readFileSync(path, "utf8")), path);
}
