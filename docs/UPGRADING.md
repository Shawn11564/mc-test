# Upgrading mc-test (for projects that use it)

> Owns: how a **consuming project** moves between mc-test versions, and the notable
> behavior changes per release. The wire contract itself is owned by `docs/PROTOCOL.md`
> and the matrix schema by `docs/ENVIRONMENTS.md` — this doc is the migration playbook.

## TL;DR

- Your **test sources are forward-compatible.** `mc-test.yml` and `*.mctest.yml` use the stable
  authoring/wire vocabulary (`docs/PROTOCOL.md`); upgrades add **optional** fields, they don't
  rename or remove existing ones. You rarely touch your tests to upgrade.
- Upgrading = **get the newer engine and rebuild it** (+ rebuild any agent jars you use).
- If a step you rely on isn't supported by the resolved driver after an upgrade, it **honest-skips**
  with a reason — never silently passes. So a botched upgrade shows up as skips, not false greens.

## How am I consuming mc-test?

| Mode | You invoke it as | Upgrade by |
|------|------------------|-----------|
| **Node CLI against a local checkout** (current default) | `node <mc-test>/packages/runner/dist/cli.js run …` | `git pull` the checkout + **rebuild** (below) |
| **Gradle front door** | `./gradlew mcTest` (plugin `io.mctest.mc-test`) | bump the plugin version / re-publish to `mavenLocal`; rebuild engine if it's a local checkout |
| **CI (GitHub Actions)** | the workflow from `mc-test init-ci` | bump `engine-ref` (or re-run `init-ci`); see `docs/CI.md` |

Most mod/plugin repos today use the **Node CLI** mode (e.g. `geckolib-examples` / Pokeblocks).

## Updating a local checkout (Node CLI mode)

From your `mc-test` checkout:

```bash
git pull                                  # get the newer engine
npm ci                                    # deps may have changed
# rebuild in dependency order (npm workspaces are not topo-sorted):
npm run build -w @mc-test/protocol
npm run build -w @mc-test/driver-headless
npm run build -w @mc-test/driver-inprocess
npm run build -w @mc-test/driver-pixel
npm run build -w @mc-test/runner
```

If your matrix lists `agents:` (for `assertPluginState` / `mod.loaded` / fixtures), rebuild those jars:

```bash
gradle -p agents :core:publishToMavenLocal :server-bukkit:jar     # Paper/Spigot plugins
gradle -p agents :core:publishToMavenLocal :server-fabric:build   # modded Fabric server
# …and :server-forge:build / :server-neoforge:build for those loaders
```

Then re-run your tests exactly as before — your `mc-test.yml` and `mctests/**` are unchanged.

> Sanity check after upgrading: `node <mc-test>/packages/runner/dist/cli.js doctor` (Java, ports,
> downloads, matrix) and `… list --matrix mc-test.yml` (targets parse).

## Notable changes

### File-cleanup release — automatic workspace GC + `clean` (commit `8e9fcb1`)

**What changed (all additive; no test-source changes required):**

- **`.mc-test/run/` is now self-bounding.** A **startup sweep** reclaims env dirs orphaned by dead
  prior runs, successful envs are removed immediately, and a failed env is kept only until the next
  run's sweep. (This fixes unbounded growth — a pre-cleanup checkout could leak **gigabytes** into
  `.mc-test/run/`.)
- **New `mc-test clean`** (Gradle: `mcTestClean`) — reclaim the workspace on demand:
  `--dry-run` (report only), `--all` (every env incl. reuse/live), `--runtime` (also clear the shared
  runtime cache).
- **New `run` flags:** `--keep` (retain every env dir), `--reuse` (rapid-dev: one reset-between-runs
  dir per target), `--no-share` (don't share the heavy runtime cache).
- **New optional `provision` fields** in `mc-test.yml`: `keepWorkDir`, `reuse`, `shareRuntime`
  (defaults preserve prior behavior except the GC above). See `docs/ENVIRONMENTS.md` §2.9–2.11.
- **Shared runtime cache** at `~/.mc-test/cache/runtime/` (junctions on Windows) so a fresh env links
  in `libraries/cache/versions` (~130 MB/build) instead of re-downloading.

**If you're coming from BEFORE this release** (e.g. `geckolib-examples` / Pokeblocks):

1. Update + rebuild the engine (see "Updating a local checkout" above).
2. **One-time reclaim** of any pre-cleanup leak — pick one:
   ```bash
   node <mc-test>/packages/runner/dist/cli.js clean --all --matrix mc-test.yml   # in your project dir
   #   …or just delete the directory:
   rm -rf .mc-test          # PowerShell: Remove-Item -Recurse -Force .mc-test
   ```
   After this, the workspace stays bounded automatically; no recurring cleanup needed.
3. **Behavior note:** envs are now cleaned after each run. If you previously inspected
   `.mc-test/run/<…>` for server logs after a *passing* run, pass `--keep` (or read the per-failure
   artifacts bundle under your `--out` dir, which is unaffected).
4. Confirm `.mc-test/` and `mc-test-report/` are git-ignored (they're run artifacts; your **test
   sources** `mc-test.yml` + `mctests/**` stay tracked).
5. **Add CI** while you're here: `node <mc-test>/.../cli.js init-ci` → see `docs/CI.md`.

Nothing in the wire vocabulary, selectors, capabilities, or step verbs changed in this release, so
your `.mctest.yml` files need no edits.

## If you DO hit an incompatibility

A genuine breaking change to a wire name, capability key, selector key, error code, step verb, or a
`mc-test.yml` field will be called out here and in the owning doc (`docs/PROTOCOL.md` /
`docs/ENVIRONMENTS.md`). If a step starts skipping with `NO_COMPATIBLE_DRIVER` after an upgrade, check
its `requires:` against the driver's advertised capabilities (`docs/CAPABILITIES.md`) — the skip
`unmet[]` names exactly what's missing.
