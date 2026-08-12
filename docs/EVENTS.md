# The `--events` run stream (NDJSON)

`mc-test run --events <stdout|stderr|path>` emits one JSON object per line as the
run happens, so a consumer can show a matrix run **live** instead of waiting for
`results.json` at the end. Spec: `commandcenter/spec/40-testing-loop.md` §6.

```bash
mc-test run tests/mctest/placement.matrix.yml --target paper-1.21.1 --events run.ndjson
mc-test run ... --events            # bare flag → stdout, interleaved with the human output
mc-test run ... --events stderr     # keep stdout clean for piping
```

Ordinary console output is *not* JSON, so a consumer reading stdout simply
ignores every line that does not parse — no separate channel is needed. A file
sink is truncated at open: one file per run, never appended across runs.

Emission is **fire-and-forget**: a broken pipe, a full disk or a consumer that
went away can never change a verdict or fail a run.

## Event types

Seven types, in this order per case:

```
run-start → ( case-start → ( step-start → step-pass|step-fail )* → case-end )* → run-end
```

| Type | When | Key fields |
|------|------|-----------|
| `run-start` | once, before the first boot | `cases[]` (the DECLARED universe), `summary` |
| `case-start` | a case begins | `caseId`, `config` |
| `step-start` | a step begins | `caseId`, `step` |
| `step-pass` | a step ended without failing | `caseId`, `step`, `status`, `ms`, `detail` |
| `step-fail` | a step failed | the same, plus `expected`/`actual`/`evidence` when the step was an invariant |
| `case-end` | a case is decided | `caseId`, `config`, `status`, `ms`, `failedStep`, `expected`, `actual`, `evidence`, `skipReason`, `invariantRef`, `exception` |
| `run-end` | once, after the report is written | `summary` |

Every event carries `type` and an ISO-8601 `timestamp`. Fields are
`lowerCamelCase` (the JSON *report* uses `snake_case` for its per-case keys; the
stream deliberately matches its consumer, which is why `invariant_ref` in
`results.json` is `invariantRef` here).

**There is no `step-skip`.** A skipped step is a `step-pass` carrying
`status: "skip"` — the `status` field is authoritative, never the type name.
`status` is one of `pass` | `fail` | `error` | `skip`, the same four verdicts
`results.json` uses.

## Contracts a consumer may rely on

- **`caseId` is the report's case id.** Both come from one function, so a live
  view and `results.json` describe exactly the same cases:
  `<test>[<case>]@<target>`, or `<test>@<target>` for a test with no `matrix:`.
- **`step` is `<index>:<verb>`** and is unique within a case — a consumer keying
  open steps by `(caseId, step)` will never merge two steps. Negative indices are
  case mechanics (`-1:fixture` is the per-case reset); the invariant's own steps
  are numbered from 1000 (`1000:getBlock`), so "which steps are the oracle" is
  visible in the stream.
- **`run-start` announces the whole declared universe** (`cases[]` with each id
  and config), so a trellis can draw the full matrix before the first case runs.
- **Every case in the report appears in the stream.** Cases decided before any
  session opened — a preflight skip, no compatible driver, a provisioning failure
  — are swept in as a `case-start`/`case-end` pair just before `run-end`.
- **`case-end` is the authority on a case**, not the sum of its steps: an
  invariant nothing could evaluate ends `skip` even though every step passed
  (`skipReason: "INVARIANT_NOT_EVALUATED …"`).
- Under `--concurrency > 1`, events from different cases interleave; each carries
  its `caseId`.

## Example (abridged, from a real run)

```json
{"type":"run-start","timestamp":"2026-08-12T03:57:30.003Z","cases":[{"id":"regions-open-each[region=TestRegion]@paper-1.20.4","config":{"target":"paper-1.20.4","region":"TestRegion","loader":"paper","mc":"1.20.4"}}],"summary":{"declared":3,"coverageModel":"full","target":"paper-1.20.4","sha":"9676653…"}}
{"type":"case-start","timestamp":"…","caseId":"regions-open-each[region=TestRegion]@paper-1.20.4","config":{"target":"paper-1.20.4","region":"TestRegion","loader":"paper","mc":"1.20.4","driver":"headless"}}
{"type":"step-start","timestamp":"…","caseId":"regions-open-each[region=TestRegion]@paper-1.20.4","step":"0:join"}
{"type":"step-pass","timestamp":"…","caseId":"regions-open-each[region=TestRegion]@paper-1.20.4","step":"0:join","status":"pass","ms":1186,"detail":"joined as Tester"}
{"type":"case-end","timestamp":"…","caseId":"regions-open-each[region=TestRegion]@paper-1.20.4","config":{…},"status":"pass","ms":1704,"expected":"chat contains \"Region loaded: TestRegion\" AND pluginState regions.active = TestRegion","actual":"chat matched: \"Region loaded: TestRegion\" ; pluginState regions.active = \"TestRegion\"","invariantRef":"regions-open-each#expect[0]"}
{"type":"run-end","timestamp":"…","summary":{"declared":3,"executed":3,"passed":3,"failed":0,"errored":0,"skipped":0,"coverageModel":"full","target":"paper-1.20.4","sha":"9676653…"}}
```

## Replaying a log

`replayEvents(lines)` (exported from `@mc-test/runner`) rebuilds a run from its
log alone — the same reduction a live UI performs, kept in-repo as the stream's
own conformance check. `packages/runner/test/events.test.ts` runs a matrix with
the stream attached and asserts the replay matches that run's `results.json`
case-for-case, step-for-step, including a red case's `failedStep` and the
oracle's `expected`/`actual`. A stream that cannot rebuild its own run is not a
faithful stream, however well-formed each line looks.
