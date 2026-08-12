/**
 * The NDJSON run-event stream (`--events`; spec commandcenter/40-testing-loop.md §6).
 *
 * One JSON object per line, emitted as the run happens, so a live consumer can
 * animate a matrix run instead of waiting for `results.json` at the end. The
 * vocabulary is fixed by the consumer that already exists (Command Center's
 * `src/lib/mcTestEvents.ts` + `src/modules/testing/liveReplay.ts`): seven event
 * types, `lowerCamelCase` fields, ISO timestamps.
 *
 * Invariants that consumer depends on — do not break them casually:
 *  - `caseId` is the SAME id `results.json` uses (`caseIdOf`), so a live view and
 *    the final report describe the same cases.
 *  - `step` labels are `<index>:<verb>`, unique within a case: the consumer keys
 *    open steps by `(caseId, step)` and would otherwise merge two steps into one.
 *  - `run-start` carries the DECLARED universe (`cases[]`), which is what lets a
 *    trellis draw the whole matrix before a single case has run.
 *  - there is no `step-skip` type: a skipped step is a `step-pass` carrying
 *    `status: "skip"`. The `status` field is authoritative, never the type name.
 */
import { appendFileSync, mkdirSync, openSync, closeSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { CaseStatus, ResultCase, ResultsReport } from "./ResultsReporter.js";

export type McTestEventType =
  | "run-start"
  | "case-start"
  | "step-start"
  | "step-pass"
  | "step-fail"
  | "case-end"
  | "run-end";

/** Run-level counters carried by `run-start` (partial) and `run-end` (complete). */
export interface EventSummary {
  declared?: number;
  executed?: number;
  passed?: number;
  failed?: number;
  errored?: number;
  skipped?: number;
  coverageModel?: string;
  target?: string;
  sha?: string;
}

/** One declared case, as announced up front by `run-start`. */
export interface EventDeclaredCase {
  id: string;
  config: Record<string, unknown>;
}

/** The on-the-wire event object (fields present only when meaningful). */
export interface McTestEvent {
  type: McTestEventType;
  timestamp: string;
  caseId?: string;
  config?: Record<string, unknown>;
  step?: string;
  status?: CaseStatus;
  ms?: number;
  detail?: string;
  failedStep?: string;
  expected?: string;
  actual?: string;
  evidence?: string[];
  skipReason?: string;
  invariantRef?: string;
  exception?: string;
  cases?: EventDeclaredCase[];
  summary?: EventSummary;
}

const drop = <T extends Record<string, unknown>>(event: T): T =>
  Object.fromEntries(Object.entries(event).filter(([, value]) => value !== undefined)) as T;

/**
 * Emits the stream. Every method is fire-and-forget and MUST never throw into a
 * run: a broken pipe or a full disk is a reporting problem, and turning a green
 * run red because nobody was listening would be its own kind of lie.
 */
export class EventStream {
  /** Case ids that have already announced themselves (see `ensureAnnounced`). */
  private readonly started = new Set<string>();
  private broken = false;

  constructor(
    private readonly write: (line: string) => void,
    private readonly closeSink?: () => void,
    /** Injectable clock — the replay tests need deterministic timestamps. */
    private readonly now: () => Date = () => new Date(),
  ) {}

  private emit(event: McTestEvent): void {
    if (this.broken) return;
    try {
      this.write(`${JSON.stringify(drop({ ...event, timestamp: this.now().toISOString() }))}\n`);
    } catch {
      // One failure is enough: stop trying rather than spamming the console.
      this.broken = true;
    }
  }

  runStart(cases: EventDeclaredCase[], summary: EventSummary): void {
    this.emit({ type: "run-start", timestamp: "", cases, summary });
  }

  caseStart(caseId: string, config: Record<string, unknown>): void {
    this.started.add(caseId);
    this.emit({ type: "case-start", timestamp: "", caseId, config });
  }

  stepStart(caseId: string, step: string): void {
    this.emit({ type: "step-start", timestamp: "", caseId, step });
  }

  stepEnd(
    caseId: string,
    step: string,
    status: CaseStatus,
    ms: number,
    extra: Pick<McTestEvent, "detail" | "expected" | "actual" | "evidence" | "skipReason"> = {},
  ): void {
    this.emit({
      type: status === "fail" || status === "error" ? "step-fail" : "step-pass",
      timestamp: "",
      caseId,
      step,
      status,
      ms,
      ...extra,
    });
  }

  /** Close a case from its final report row, so live and final agree exactly. */
  caseEnd(result: ResultCase): void {
    this.started.add(result.id);
    this.emit({
      type: "case-end",
      timestamp: "",
      caseId: result.id,
      config: result.config,
      status: result.status,
      ms: result.ms,
      failedStep: result.failed_step,
      expected: result.expected,
      actual: result.actual,
      evidence: result.evidence.length ? result.evidence : undefined,
      skipReason: result.skip_reason,
      invariantRef: result.invariant_ref,
      exception: result.exception,
    });
  }

  /**
   * Announce a case that never reached the runner — a preflight/driver skip or a
   * provisioning error — as a start/end pair, so every declared case the report
   * contains also appears in the stream. Without this a live view would sit
   * forever on cases that were decided before any session opened.
   */
  ensureAnnounced(result: ResultCase): void {
    if (this.started.has(result.id)) return;
    this.caseStart(result.id, result.config);
    this.caseEnd(result);
  }

  runEnd(report: ResultsReport): void {
    this.emit({
      type: "run-end",
      timestamp: "",
      summary: {
        declared: report.declared,
        executed: report.executed,
        passed: report.passed,
        failed: report.failed,
        errored: report.errored,
        skipped: report.skipped,
        coverageModel: report.coverage_model,
        target: report.target,
        sha: report.sha,
      },
    });
  }

  close(): void {
    try {
      this.closeSink?.();
    } catch {
      /* closing a report sink must never fail a run */
    }
  }
}

/**
 * Open the stream named by `--events`: bare (`true`) or `stdout` writes NDJSON to
 * stdout beside the human output (a consumer ignores non-JSON lines); `stderr`
 * keeps stdout clean; anything else is a file path, truncated at open.
 */
export function openEventStream(spec: string | undefined): EventStream | undefined {
  if (spec === undefined || spec === "false" || spec === "") return undefined;
  if (spec === "true" || spec === "stdout") {
    return new EventStream((line) => process.stdout.write(line));
  }
  if (spec === "stderr") return new EventStream((line) => process.stderr.write(line));
  const path = resolve(spec);
  mkdirSync(dirname(path), { recursive: true });
  closeSync(openSync(path, "w")); // truncate: one file per run, never appended across runs
  return new EventStream((line) => appendFileSync(path, line, "utf8"));
}

/** Parse one NDJSON line; non-JSON console output returns `null`. */
export function parseEventLine(line: string): McTestEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed) as McTestEvent;
    return typeof parsed?.type === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/** A run reconstructed from its event log (the shape `results.json` also describes). */
export interface ReplayedRun {
  summary: EventSummary;
  declared: EventDeclaredCase[];
  cases: Array<{
    id: string;
    config: Record<string, unknown>;
    status: CaseStatus;
    ms: number;
    steps: Array<{ step: string; status: CaseStatus; ms: number; detail?: string }>;
    failedStep?: string;
    expected?: string;
    actual?: string;
    evidence?: string[];
    skipReason?: string;
    invariantRef?: string;
    exception?: string;
  }>;
}

/**
 * Replay an event log back into a run. This is the stream's own conformance
 * check: a log that cannot rebuild the run it described is not a faithful
 * stream, however well-formed each line looks. (Command Center's `liveReplay.ts`
 * is the same reduction with a UI attached; this one exists so mc-test tests its
 * OWN contract rather than trusting the consumer to notice.)
 */
export function replayEvents(lines: Iterable<string>): ReplayedRun {
  const run: ReplayedRun = { summary: {}, declared: [], cases: [] };
  const byId = new Map<string, ReplayedRun["cases"][number]>();
  const ensure = (id: string, config?: Record<string, unknown>) => {
    let entry = byId.get(id);
    if (!entry) {
      entry = { id, config: config ?? {}, status: "skip", ms: 0, steps: [] };
      byId.set(id, entry);
      run.cases.push(entry);
    }
    if (config && Object.keys(config).length) entry.config = config;
    return entry;
  };

  for (const line of lines) {
    const event = parseEventLine(line);
    if (!event) continue;
    if (event.type === "run-start") {
      run.declared = event.cases ?? [];
      run.summary = { ...run.summary, ...(event.summary ?? {}) };
      continue;
    }
    if (event.type === "run-end") {
      run.summary = { ...run.summary, ...(event.summary ?? {}) };
      continue;
    }
    if (!event.caseId) continue;
    const entry = ensure(event.caseId, event.config);
    if (event.type === "step-start") {
      entry.steps.push({ step: event.step ?? `step ${entry.steps.length}`, status: "skip", ms: 0 });
      continue;
    }
    if (event.type === "step-pass" || event.type === "step-fail") {
      const label = event.step ?? "";
      const open = [...entry.steps].reverse().find((s) => s.step === label);
      const step = open ?? { step: label, status: "skip" as CaseStatus, ms: 0 };
      if (!open) entry.steps.push(step);
      step.status = event.status ?? (event.type === "step-fail" ? "fail" : "pass");
      step.ms = event.ms ?? 0;
      if (event.detail) step.detail = event.detail;
      continue;
    }
    if (event.type === "case-end") {
      entry.status = event.status ?? "skip";
      entry.ms = event.ms ?? 0;
      if (event.failedStep) entry.failedStep = event.failedStep;
      if (event.expected) entry.expected = event.expected;
      if (event.actual) entry.actual = event.actual;
      if (event.evidence) entry.evidence = event.evidence;
      if (event.skipReason) entry.skipReason = event.skipReason;
      if (event.invariantRef) entry.invariantRef = event.invariantRef;
      if (event.exception) entry.exception = event.exception;
    }
  }
  return run;
}
