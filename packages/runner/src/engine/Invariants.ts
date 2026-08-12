/**
 * The `expect:` invariant DSL (spec commandcenter/40-testing-loop.md §4–§5).
 *
 * A matrix run judges every generated case against ONE shared oracle written
 * once: an ordered list of `expect:` branches whose `when:` selects the cases a
 * branch applies to, and whose expected values are FUNCTIONS of the case config
 * (`$face`, `$held`, … — the same `$dimension` substitution the steps use, see
 * `Substitute.ts`). That is what makes an invariant an oracle rather than 36
 * hand-written assertions: the assertions cannot be quietly reshaped per case to
 * match whatever the code happened to do.
 *
 * Everything here is PURE: branches compile to ordinary `NormalizedStep`s in a
 * high index band (`INVARIANT_STEP_BASE`), appended after the authored steps, so
 * they run through the same executor, the same routing, and the same honest
 * capability skips as everything else — no second assertion path, no assertion
 * logic inside an agent (Prime Directive 2).
 *
 * Deliberate limits (kept honest rather than faked):
 *  - clauses map onto truth verbs that actually exist: `block`, `chat`,
 *    `pluginState`, `container`. An unknown key is a parse ERROR, never ignored.
 *  - `actor:` (spec §9 phase 5, multi-actor) is rejected with a named reason
 *    instead of being silently dropped, which would read as coverage.
 *  - an invariant step that SKIPS (its capability is unadvertised) turns the
 *    case into a skip, never a pass — see `Runner.runTest`.
 */
import type { NormalizedStep, NormalizedTest } from "../model/Step.js";
import { stringify, substituteBindings } from "./Substitute.js";

/** Integer block position. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Where invariant steps are numbered from. A distinct band (rather than
 * continuing the authored indices) makes "which steps are the ORACLE" obvious in
 * any report, and keeps the runner's `index < 0` fixture-mechanics test intact.
 */
export const INVARIANT_STEP_BASE = 1000;

/** Outward normal of each block face — how `"chest + $face"` resolves. */
const FACE_VECTORS: Record<string, Vec3> = {
  up: { x: 0, y: 1, z: 0 },
  down: { x: 0, y: -1, z: 0 },
  north: { x: 0, y: 0, z: -1 },
  south: { x: 0, y: 0, z: 1 },
  west: { x: -1, y: 0, z: 0 },
  east: { x: 1, y: 0, z: 0 },
};

/** Assertion clause kinds, each backed by a truth verb that already exists. */
export const CLAUSE_KINDS = ["block", "chat", "pluginState", "container"] as const;
export type ClauseKind = (typeof CLAUSE_KINDS)[number];

/** Keys allowed on each clause kind (anything else is a parse error). */
const CLAUSE_KEYS: Record<ClauseKind, string[]> = {
  block: ["pos", "world", "is", "absent", "properties", "nbt", "timeoutMs", "intervalMs"],
  chat: ["contains", "matches", "regex", "channel", "timeoutMs"],
  pluginState: ["plugin", "query", "args", "is", "timeoutMs", "intervalMs"],
  container: ["pos", "world", "is", "count", "slots"],
};

/** Keys allowed on an `expect:` branch. */
const BRANCH_KEYS = new Set<string>(["when", "because", ...CLAUSE_KINDS]);

/** Keys that name a phase-5 capability; rejected loudly rather than ignored. */
const NOT_YET: Record<string, string> = {
  actor: "multi-actor expectations are spec §9 phase 5 (one actor per session today)",
  "unchanged-unless": "inventory-delta expectations need player-inventory truth (spec §9 phase 5)",
};

/** One parsed assertion clause: its kind + its (still-unsubstituted) fields. */
export interface ExpectClause {
  kind: ClauseKind;
  spec: Record<string, unknown>;
}

/** One `expect:` branch — the cases it applies to, and what it demands of them. */
export interface ExpectBranch {
  /** Dimension → value(s) this branch applies to. Absent = every case. */
  when?: Record<string, unknown>;
  /** Free-text rationale carried into the report (the one-sentence oracle). */
  because?: string;
  clauses: ExpectClause[];
}

/**
 * A per-case override (spec §4). Allowed, but it REPLACES the shared oracle for
 * the named case(s), so it is flagged on the case in results.json and requires a
 * written `reason:` — unjustified exceptions are exactly where a circular oracle
 * sneaks back in (spec §5).
 */
export interface ExceptEntry {
  /** Exact case id, e.g. `face=north,held=empty`. */
  case?: string;
  /** Dimension → value(s), like a branch's `when:`. */
  when?: Record<string, unknown>;
  reason: string;
  branches: ExpectBranch[];
}

/** The invariant annotation carried on a compiled step and onto the result. */
export interface InvariantAnnotation {
  /** `<test>#expect[2]` / `<test>#except[0].expect[0]` — the authored branch. */
  ref: string;
  /** What this branch demands of THIS case, rendered for the report. */
  expected: string;
  /** Set when an `except:` override judged the case (flagged, never hidden). */
  exception?: string;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function rejectNotYet(spec: Record<string, unknown>, source: string, at: string): void {
  for (const [key, why] of Object.entries(NOT_YET)) {
    if (key in spec) {
      throw new Error(`${source}: ${at} uses '${key}', which mc-test cannot evaluate — ${why}. Remove it rather than let it read as coverage.`);
    }
  }
}

function checkKeys(spec: Record<string, unknown>, allowed: string[], source: string, at: string): void {
  rejectNotYet(spec, source, at);
  const unknown = Object.keys(spec).filter((k) => !allowed.includes(k));
  if (unknown.length) {
    throw new Error(`${source}: ${at} has unknown key(s) ${unknown.join(", ")} (allowed: ${allowed.join(", ")})`);
  }
}

/** Validate one clause at parse time, so a malformed oracle fails loudly, not vacuously. */
function validateClause(kind: ClauseKind, spec: Record<string, unknown>, source: string, at: string): void {
  checkKeys(spec, CLAUSE_KEYS[kind], source, at);
  if (kind === "block") {
    if (spec["pos"] === undefined) throw new Error(`${source}: ${at} needs 'pos'`);
    if (spec["is"] === undefined && spec["absent"] !== true && spec["properties"] === undefined && spec["nbt"] === undefined) {
      throw new Error(`${source}: ${at} asserts nothing — give it 'is', 'absent', 'properties' or 'nbt'`);
    }
  }
  if (kind === "chat" && spec["contains"] === undefined && spec["matches"] === undefined && spec["regex"] === undefined) {
    throw new Error(`${source}: ${at} needs 'contains' (substring), 'matches' (alias of contains) or 'regex'`);
  }
  if (kind === "pluginState") {
    if (typeof spec["query"] !== "string" || !spec["query"]) throw new Error(`${source}: ${at} needs a 'query' string`);
    if (spec["is"] === undefined) {
      throw new Error(`${source}: ${at} needs 'is' — a pluginState read with no expected value cannot produce a verdict`);
    }
  }
  if (kind === "container") {
    if (spec["pos"] === undefined) throw new Error(`${source}: ${at} needs 'pos'`);
    if (spec["is"] === undefined && spec["count"] === undefined && spec["slots"] === undefined) {
      throw new Error(`${source}: ${at} asserts nothing — give it 'is', 'count' or 'slots'`);
    }
  }
}

function parseBranch(raw: unknown, source: string, at: string): ExpectBranch {
  if (!isPlainObject(raw)) throw new Error(`${source}: ${at} must be a mapping`);
  rejectNotYet(raw, source, at);
  const unknown = Object.keys(raw).filter((k) => !BRANCH_KEYS.has(k));
  if (unknown.length) {
    throw new Error(`${source}: ${at} has unknown key(s) ${unknown.join(", ")} (allowed: when, because, ${CLAUSE_KINDS.join(", ")})`);
  }
  const when = raw["when"];
  if (when !== undefined && !isPlainObject(when)) {
    throw new Error(`${source}: ${at}.when must be a mapping of dimension → value(s)`);
  }
  const clauses: ExpectClause[] = [];
  for (const kind of CLAUSE_KINDS) {
    const value = raw[kind];
    if (value === undefined) continue;
    const list = Array.isArray(value) ? value : [value];
    list.forEach((spec, i) => {
      const clauseAt = `${at}.${kind}${Array.isArray(value) ? `[${i}]` : ""}`;
      if (!isPlainObject(spec)) throw new Error(`${source}: ${clauseAt} must be a mapping`);
      validateClause(kind, spec, source, clauseAt);
      clauses.push({ kind, spec });
    });
  }
  if (!clauses.length) {
    throw new Error(
      `${source}: ${at} asserts nothing — a branch with no ${CLAUSE_KINDS.join("/")} clause can only pass vacuously`,
    );
  }
  return {
    ...(when ? { when: when as Record<string, unknown> } : {}),
    ...(typeof raw["because"] === "string" ? { because: raw["because"] } : {}),
    clauses,
  };
}

/** Parse an authored `expect:` block into branches (validated, not yet bound to a case). */
export function parseExpect(raw: unknown, source: string, path = "expect"): ExpectBranch[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error(`${source}: '${path}' must be a list of branches`);
  return raw.map((entry, i) => parseBranch(entry, source, `${path}[${i}]`));
}

/** Parse an authored `except:` block (per-case overrides — always flagged). */
export function parseExcept(raw: unknown, source: string): ExceptEntry[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error(`${source}: 'except' must be a list of overrides`);
  return raw.map((entry, i) => {
    const at = `except[${i}]`;
    if (!isPlainObject(entry)) throw new Error(`${source}: ${at} must be a mapping`);
    const unknown = Object.keys(entry).filter((k) => !["case", "when", "reason", "expect"].includes(k));
    if (unknown.length) throw new Error(`${source}: ${at} has unknown key(s) ${unknown.join(", ")} (allowed: case, when, reason, expect)`);
    if (entry["case"] === undefined && entry["when"] === undefined) {
      throw new Error(`${source}: ${at} must name the case(s) it overrides with 'case' or 'when'`);
    }
    if (typeof entry["reason"] !== "string" || !entry["reason"].trim()) {
      throw new Error(
        `${source}: ${at} needs a written 'reason' — an unjustified per-case exception is how a circular oracle sneaks back (spec §5)`,
      );
    }
    if (entry["when"] !== undefined && !isPlainObject(entry["when"])) {
      throw new Error(`${source}: ${at}.when must be a mapping of dimension → value(s)`);
    }
    const branches = parseExpect(entry["expect"], source, `${at}.expect`);
    if (!branches.length) throw new Error(`${source}: ${at} needs an 'expect' list (the replacement oracle for this case)`);
    return {
      ...(entry["case"] !== undefined ? { case: String(entry["case"]) } : {}),
      ...(entry["when"] ? { when: entry["when"] as Record<string, unknown> } : {}),
      reason: entry["reason"],
      branches,
    };
  });
}

/** Parse the optional `anchors:` block — named positions `expect:` clauses refer to. */
export function parseAnchors(raw: unknown, source: string): Record<string, Vec3> {
  if (raw === undefined) return {};
  if (!isPlainObject(raw)) throw new Error(`${source}: 'anchors' must be a mapping of name → position`);
  const out: Record<string, Vec3> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (name in FACE_VECTORS) {
      throw new Error(`${source}: anchor '${name}' collides with a block-face name; pick another name`);
    }
    out[name] = literalPos(value, `${source}: anchors.${name}`);
  }
  return out;
}

/** Coerce `{x,y,z}` or `"x,y,z"` into integer block coordinates. */
function literalPos(raw: unknown, at: string): Vec3 {
  if (typeof raw === "string") {
    const parts = raw.split(",").map((p) => Number(p.trim()));
    if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
      throw new Error(`${at}: expected "x,y,z" (got ${JSON.stringify(raw)})`);
    }
    return { x: Math.floor(parts[0]!), y: Math.floor(parts[1]!), z: Math.floor(parts[2]!) };
  }
  if (isPlainObject(raw)) {
    const [x, y, z] = [Number(raw["x"]), Number(raw["y"]), Number(raw["z"])];
    if (![x, y, z].every(Number.isFinite)) throw new Error(`${at}: expected { x, y, z } (got ${JSON.stringify(raw)})`);
    return { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) };
  }
  throw new Error(`${at}: expected { x, y, z } or "x,y,z" (got ${JSON.stringify(raw)})`);
}

/**
 * Resolve a clause `pos:` AFTER `$dimension` substitution. Accepts a literal
 * position, a named anchor, or anchor/position ± face-offset arithmetic — which
 * is what lets one invariant say "the block on the face we clicked":
 *
 *   pos: "chest + $face"   →  anchors.chest offset by the case's face normal
 */
export function resolvePos(raw: unknown, anchors: Record<string, Vec3>, at: string): Vec3 {
  if (typeof raw !== "string") return literalPos(raw, at);
  // `<base> ± <term> ± <term>`. Operators are whitespace-separated so a literal
  // triple keeps its negative components: `"0,64,-1 + north"` parses cleanly.
  const terms = raw.trim().split(/\s+([+-])\s+/);
  const head = terms[0]!.trim();
  const anchor = anchors[head];
  const base = anchor ? { ...anchor } : namedOrLiteral(head, anchors, at);
  for (let i = 1; i < terms.length; i += 2) {
    const sign = terms[i] === "-" ? -1 : 1;
    const term = (terms[i + 1] ?? "").trim();
    if (!term) throw new Error(`${at}: trailing '${terms[i]}' in position expression ${JSON.stringify(raw)}`);
    const face = FACE_VECTORS[term.toLowerCase()];
    const offset = face ?? offsetTerm(term, at);
    base.x += sign * offset.x;
    base.y += sign * offset.y;
    base.z += sign * offset.z;
  }
  return base;
}

/** The head of a position expression: a declared anchor or a literal triple. */
function namedOrLiteral(term: string, anchors: Record<string, Vec3>, at: string): Vec3 {
  if (term.includes(",")) return literalPos(term, at);
  const known = Object.keys(anchors);
  throw new Error(
    `${at}: unknown anchor '${term}' — declare it under 'anchors:' or write a literal "x,y,z"` +
      (known.length ? ` (known anchors: ${known.join(", ")})` : ""),
  );
}

/** An offset term: a face name (handled by the caller) or a literal `dx,dy,dz`. */
function offsetTerm(term: string, at: string): Vec3 {
  if (term.includes(",")) return literalPos(term, at);
  throw new Error(
    `${at}: '${term}' is not an offset — offsets are face names (${Object.keys(FACE_VECTORS).join("/")}) or "dx,dy,dz"`,
  );
}

/** Case-insensitive token equality that survives `null` and non-string values. */
function sameToken(want: unknown, got: unknown): boolean {
  if (got === undefined) return false;
  if (want === null || got === null) return want === got;
  return stringify(want).trim().toLowerCase() === stringify(got).trim().toLowerCase();
}

/**
 * Does a `when:` select this case? Every listed dimension must match; a list of
 * values means any-of. A value matches either the case's symbolic config LABEL
 * (`held: sign-item`, from a map-form dimension) or its concrete value
 * (`face: north`), so an author writes whichever reads better.
 */
export function whenMatches(
  when: Record<string, unknown> | undefined,
  config: Record<string, unknown>,
  values: Record<string, unknown>,
): boolean {
  if (!when) return true;
  for (const [dimension, want] of Object.entries(when)) {
    const wants = Array.isArray(want) ? want : [want];
    const ok = wants.some((w) => sameToken(w, config[dimension]) || sameToken(w, values[dimension]));
    if (!ok) return false;
  }
  return true;
}

/** A branch selected for one case, with the reference the report cites. */
export interface SelectedBranch {
  branch: ExpectBranch;
  ref: string;
  exception?: string;
}

/**
 * Choose the branches that judge one case. A matching `except:` override
 * REPLACES the shared oracle (and stamps the case with its reason); otherwise
 * every `expect:` branch whose `when:` matches applies, ANDed together.
 */
export function selectBranches(
  test: Pick<NormalizedTest, "name" | "expect" | "except">,
  config: Record<string, unknown>,
  values: Record<string, unknown>,
  caseId?: string,
): SelectedBranch[] {
  const overrides = test.except ?? [];
  for (const [i, entry] of overrides.entries()) {
    const byId = entry.case !== undefined && caseId !== undefined && entry.case.trim() === caseId.trim();
    const byWhen = entry.when !== undefined && whenMatches(entry.when, config, values);
    if (!byId && !byWhen) continue;
    return entry.branches
      .filter((branch) => whenMatches(branch.when, config, values))
      .map((branch, j) => ({
        branch,
        ref: `${test.name}#except[${i}].expect[${j}]`,
        exception: `except[${i}]: ${entry.reason}`,
      }));
  }
  return (test.expect ?? [])
    .map((branch, i) => ({ branch, ref: `${test.name}#expect[${i}]` }))
    .filter((selected) => whenMatches(selected.branch.when, config, values));
}

/** Render one clause's demand for the report's `expected` field. */
function describeClause(kind: ClauseKind, spec: Record<string, unknown>, pos?: Vec3): string {
  const where = pos ? `${pos.x},${pos.y},${pos.z}` : "";
  if (kind === "block") {
    const parts: string[] = [];
    if (spec["absent"] === true) parts.push("is empty (minecraft:air)");
    else if (spec["is"] !== undefined) parts.push(`is ${String(spec["is"])}`);
    if (isPlainObject(spec["properties"])) {
      parts.push(`properties {${Object.entries(spec["properties"]).map(([k, v]) => `${k}=${stringify(v)}`).join(", ")}}`);
    }
    if (isPlainObject(spec["nbt"])) parts.push(`nbt {${Object.keys(spec["nbt"]).join(", ")}}`);
    return `block ${where} ${parts.join(" and ")}`;
  }
  if (kind === "chat") {
    const contains = spec["contains"] ?? spec["matches"];
    return spec["regex"] !== undefined ? `chat matches /${String(spec["regex"])}/` : `chat contains "${String(contains)}"`;
  }
  if (kind === "pluginState") {
    return `pluginState ${String(spec["query"])} = ${stringify(spec["is"])}`;
  }
  const parts: string[] = [];
  if (spec["is"] !== undefined) parts.push(`is ${String(spec["is"])}`);
  if (spec["count"] !== undefined) parts.push(`holds ${String(spec["count"])} item stack(s)`);
  if (isPlainObject(spec["slots"])) parts.push(`slots {${Object.keys(spec["slots"]).join(", ")}}`);
  return `container ${where} ${parts.join(" and ")}`;
}

/** Compile one substituted clause into the truth step that evaluates it. */
function compileClause(
  kind: ClauseKind,
  spec: Record<string, unknown>,
  anchors: Record<string, Vec3>,
  at: string,
): { verb: NormalizedStep["verb"]; args: Record<string, unknown>; expected: string } {
  if (kind === "block") {
    const pos = resolvePos(spec["pos"], anchors, at);
    const want = spec["absent"] === true ? "minecraft:air" : spec["is"] !== undefined ? String(spec["is"]) : undefined;
    // A clause with a timeout is a deferred expectation (a plugin writing the
    // block a few ticks later) → the wait twin of the same probe, never a sleep.
    const timed = spec["timeoutMs"] !== undefined;
    return {
      verb: timed ? "waitForBlock" : "getBlock",
      args: {
        ...(spec["world"] !== undefined ? { world: spec["world"] } : {}),
        x: pos.x,
        y: pos.y,
        z: pos.z,
        ...(want !== undefined ? { expect: want } : {}),
        ...(spec["properties"] !== undefined ? { expectProperties: spec["properties"] } : {}),
        ...(spec["nbt"] !== undefined ? { expectNbt: spec["nbt"] } : {}),
        ...(timed ? { timeoutMs: spec["timeoutMs"] } : {}),
        ...(spec["intervalMs"] !== undefined ? { intervalMs: spec["intervalMs"] } : {}),
      },
      expected: describeClause(kind, spec, pos),
    };
  }
  if (kind === "chat") {
    const contains = spec["contains"] ?? spec["matches"];
    return {
      verb: "assertChat",
      args: {
        ...(contains !== undefined ? { contains: String(contains) } : {}),
        ...(spec["regex"] !== undefined ? { regex: String(spec["regex"]) } : {}),
        ...(spec["channel"] !== undefined ? { channel: spec["channel"] } : {}),
        timeoutMs: spec["timeoutMs"] ?? 10000,
      },
      expected: describeClause(kind, spec),
    };
  }
  if (kind === "pluginState") {
    const timed = spec["timeoutMs"] !== undefined;
    return {
      verb: timed ? "waitForPluginState" : "assertPluginState",
      args: {
        ...(spec["plugin"] !== undefined ? { plugin: spec["plugin"] } : {}),
        query: String(spec["query"]),
        ...(spec["args"] !== undefined ? { args: spec["args"] } : {}),
        expect: spec["is"],
        ...(timed ? { timeoutMs: spec["timeoutMs"] } : {}),
        ...(spec["intervalMs"] !== undefined ? { intervalMs: spec["intervalMs"] } : {}),
      },
      expected: describeClause(kind, spec),
    };
  }
  const pos = resolvePos(spec["pos"], anchors, at);
  return {
    verb: "getContainer",
    args: {
      ...(spec["world"] !== undefined ? { world: spec["world"] } : {}),
      x: pos.x,
      y: pos.y,
      z: pos.z,
      ...(spec["is"] !== undefined ? { expect: spec["is"] } : {}),
      ...(spec["count"] !== undefined ? { expectCount: spec["count"] } : {}),
      ...(spec["slots"] !== undefined ? { expectSlots: spec["slots"] } : {}),
    },
    expected: describeClause(kind, spec, pos),
  };
}

/**
 * Compile the invariant steps that judge ONE case: select the branches, resolve
 * `$dimension` values, and emit the truth steps in the invariant index band.
 */
export function compileInvariantSteps(
  test: Pick<NormalizedTest, "name" | "expect" | "except" | "anchors">,
  config: Record<string, unknown>,
  values: Record<string, unknown>,
  caseId?: string,
): NormalizedStep[] {
  const selected = selectBranches(test, config, values, caseId);
  const anchors = test.anchors ?? {};
  const steps: NormalizedStep[] = [];
  for (const { branch, ref, exception } of selected) {
    for (const [i, clause] of branch.clauses.entries()) {
      const at = `${ref}.${clause.kind}`;
      const spec = substituteBindings(clause.spec, values) as Record<string, unknown>;
      const compiled = compileClause(clause.kind, spec, anchors, at);
      steps.push({
        index: INVARIANT_STEP_BASE + steps.length,
        verb: compiled.verb,
        args: compiled.args,
        invariant: {
          ref,
          // The rationale belongs to the BRANCH, so it is carried once (on its
          // first clause) rather than repeated after every ANDed expectation.
          expected: branch.because && i === 0 ? `${compiled.expected} (${branch.because})` : compiled.expected,
          ...(exception ? { exception } : {}),
        },
      });
    }
  }
  return steps;
}

/**
 * Return the test with its case-specific invariant steps appended. Used by matrix
 * expansion (per generated case) and by the flat path (a test with an `expect:`
 * block but no `matrix:`), so an invariant judges both the same way.
 */
export function applyInvariants(
  test: NormalizedTest,
  config: Record<string, unknown> = {},
  values: Record<string, unknown> = {},
  caseId?: string,
): NormalizedTest {
  if (!test.expect?.length && !test.except?.length) return test;
  // Expansion already compiled the oracle into each generated case; applying it
  // twice would double-judge (and double-count) the same expectations.
  if (test.steps.some((step) => step.invariant)) return test;
  const steps = compileInvariantSteps(test, config, values, caseId);
  if (!steps.length) return test;
  return { ...test, steps: [...test.steps, ...steps] };
}
