# CI — build your tests + host the report on GitHub

> Owns: the `mc-test init-ci` scaffolder, the reusable workflow
> (`.github/workflows/mc-test-ci.yml`) and its inputs, and how the HTML report
> (`mc-test-report/report.html`) is published. For *running* tests locally see
> `docs/GETTING_STARTED.md`; for updating between mc-test versions see `docs/UPGRADING.md`.

A project that uses mc-test can **self-configure** a GitHub Actions workflow that, on every
push/PR, builds the SUT jar, runs the `.mctest.yml` tests across the `mc-test.yml` matrix, and
**publishes the report**:

- **always** as a downloadable **workflow artifact** (`mc-test-report`) — free, zero repo setup; and
- to **GitHub Pages** (`https://<owner>.github.io/<repo>/`) when enabled — the literal "host it on
  GitHub" path.

JUnit XML (`mc-test-report/junit/results.xml`) rides along in the artifact for any JUnit reporter.

## Quick start

```bash
# from your plugin/mod project root:
npx mc-test init-ci            # or: ./gradlew mcTestInitCi   (if you apply the Gradle plugin)
git add .github/workflows/mc-test.yml && git commit -m "ci: mc-test" && git push
```

`init-ci` writes `.github/workflows/mc-test.yml` and **never overwrites** an existing one. It
auto-detects sensible defaults from your project (Gradle vs Maven build command; `mctests/` vs
`src/mctest/` step files) — review the file and adjust `agents`/`targets` before committing.

**To host on GitHub Pages (one-time):** repo **Settings → Pages → Build and deployment → Source:
"GitHub Actions"**. Until you do, the run still succeeds and the report is in the workflow artifact.

## Two layouts

`init-ci` generates one of two equivalent workflows:

| | **Caller** (default) | **Standalone** (`--standalone`) |
|---|---|---|
| Shape | ~15-line job that `uses:` the reusable workflow in the engine repo | full self-contained workflow (clones + builds the engine inline) |
| Engine updates | flow automatically (or pin `engine-ref`) | only when you re-run `init-ci` / bump the ref |
| Needs the engine repo reachable at run time | yes (public, or same-owner private) | only `actions/checkout` of it (public, or a token) |
| Best for | most projects (cleanest) | air-gapped pins / not wanting a runtime dependency |

Both produce the identical report + artifact + Pages output.

## mc-test's own self-test report

mc-test **dogfoods this** — it publishes its OWN report the same way. The E2E workflow
(`.github/workflows/e2e.yml`, nightly + manual dispatch) runs the canonical `regions` tests across
every environment (headless Paper, the rendered Fabric/Forge/NeoForge client GUIs, and the modded
Fabric/Forge/NeoForge servers). A `publish-report` job then aggregates each lane's
`mc-test-report/report.html` into one GitHub Pages site — a landing `index.html` that links each
lane's report — served at `https://<owner>.github.io/<repo>/`, while every lane's full report stays a
downloadable workflow artifact. The `deploy-report` job is best-effort (`continue-on-error`) and uses
the same `upload-pages-artifact` → `deploy-pages` mechanism as the consumer publish above; enable it
one-time via repo **Settings → Pages → Source: "GitHub Actions"**.

## Reusable workflow inputs

The caller passes these to `Shawn11564/mc-test/.github/workflows/mc-test-ci.yml`:

| input | default | meaning |
|-------|---------|---------|
| `build-command` | `./gradlew build` | command that builds the SUT jar(s) the matrix references (`mvn -B package`, `./gradlew shadowJar`, …) |
| `tests` | `mctests/**/*.mctest.yml` | glob of step files (bash globstar) |
| `targets` | `all` | a target id, a comma-separated subset, or `all` |
| `matrix` | `mc-test.yml` | path to the matrix file |
| `agents` | `server-bukkit` | space-separated engine agents to build (see below) |
| `java-version` | `21` | JDK (Temurin) for the SUT build + server boot |
| `node-version` | `20` | Node used to build/run the engine |
| `engine-repo` / `engine-ref` | `Shawn11564/mc-test` / `main` | which engine to build (pin a tag for reproducibility) |
| `pages` | `true` | also deploy the report to GitHub Pages (best-effort; artifact is always uploaded) |
| `fail-on-skip` | `false` | fail the run if any `(test × target)` cell is skipped |

## Agents (so server-truth steps don't skip)

Steps that assert real server state — `assertPluginState`, `mod.loaded`, fixtures — need a co-selected
**truth agent**. CI builds the ones you name in `agents`; a target with no built agent **honest-skips**
(`NO_SERVER_AGENT`) rather than passing falsely. Pick by your target's server:

- **Paper/Spigot plugin** → `server-bukkit` (the default).
- **Modded server** (Fabric/Forge/NeoForge) → `server-fabric` / `server-forge` / `server-neoforge`,
  e.g. `agents: 'server-fabric server-neoforge'`.

Agent builds are **best-effort**: a flaky toolchain download won't fail the run — those steps just skip.
Fabric (Loom) is the reliably-green showcase; Forge/NeoForge agent builds are acceptance-only/heavier.

## Troubleshooting

- **Pages deploy failed / 404** — enable Pages (Settings → Pages → Source "GitHub Actions"). The
  publish job is `continue-on-error`, so the report is still in the `mc-test-report` artifact.
- **`no step files matched`** — fix the `tests` glob (e.g. your files live under `src/mctest/`).
- **A server-truth step skipped (`NO_SERVER_AGENT`)** — add the matching loader's agent to `agents`.
- **The matrix jar path isn't found** — `build-command` must produce the jar your `mc-test.yml`
  references (paths in the matrix are relative to the repo root, where the runner runs).
- **Caller can't resolve the reusable workflow** — the engine repo must be public (or same-owner with
  reusable-workflow access), or use `--standalone`.
