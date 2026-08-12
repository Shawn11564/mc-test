# Labeled mutants (permanent negative controls)

Spec `commandcenter/spec/40-testing-loop.md` §5 asks every invariant to be
validated by two controls, not by inspection:

1. **positive** — against a known-good build it must be green, or the invariant is
   too strict / mistranslated;
2. **negative** — against a known-bad build it must go red **on exactly the bad
   combinations**, or the invariant does not actually catch the bug it claims to.

Git history supplies real mutants for (2) once a bug has happened. Before that —
and for an example SUT that has never had the bug — a mutant is committed
deliberately, on its own branch, clearly labeled. Each one below is a permanent,
re-runnable negative control: it never merges to `main`, and it is the reason we
can say the invariant *detects* something rather than merely *passing*.

Run one with:

```bash
mc-test validate <check.mctest.yml> --against-commit <sha> --expect-fail \
        --build "<build command>" --artifact <built jar> --target <target id>
```

`validate` checks the sha out in a worktree, builds **that** commit, and runs
**today's** check against it — the direction matters, since running the old
commit's own tests against itself would prove nothing. See
[`docs/AUTHORING.md`](../docs/AUTHORING.md#validating-an-invariant-the-lab-controls).

---

## `mutants/regions-active-pinned` — "announces every region, activates one"

| | |
|---|---|
| **Branch** | `mutants/regions-active-pinned` |
| **Commit** | `9868d2a63aa96cfc3ee62941824e331aeb27ebb9` |
| **SUT** | `examples/regions/plugin` (OpenRegions) |
| **Breaks** | `OpenRegionsPlugin#handleClick`: the region-entry click sends the truthful `Region loaded: <name>` chat line but calls `regions.setActive("Spawn")` instead of `setActive(name)`. |
| **Check** | `examples/regions/regions.matrix.mctest.yml` |
| **Must go red on** | `region=TestRegion`, `region=Market` |
| **Must stay green on** | `region=Spawn` (the pinned value is genuinely correct there) |

This is the failure shape the whole matrix engine exists for: **chat is right for
every case while the authoritative state is wrong for all but one.** A test that
opened a single region — or that asserted only chat — is green on this build. The
invariant catches it because its expected value is a function of the case config
(`regions.active == $region`), so two of the three cases contradict it.

Reproduce (Java 21 + Maven; boots a real Paper 1.20.4):

```bash
node packages/runner/dist/cli.js validate examples/regions/regions.matrix.mctest.yml \
     --against-commit 9868d2a63aa96cfc3ee62941824e331aeb27ebb9 --expect-fail \
     --build "mvn -B -q -DskipTests -f examples/regions/plugin/pom.xml package" \
     --artifact examples/regions/plugin/target/regions-plugin.jar \
     --target paper-1.20.4
```

**Recorded 2026-08-12** — negative control **held**: `3 declared-executed 3, red 2,
green 1, skipped 0`, exit 0. `region=TestRegion` and `region=Market` fail with
`pluginState assertion failed: regions.active = "Spawn"` while their chat clause
passes; `region=Spawn` passes outright.

The matching **positive control** is the same command against the mainline,
without `--expect-fail`: 3/3 green, exit 0. Running it *with* `--expect-fail` is
the honest self-check — it exits 1 (`demanded red, but all 3 executed case(s)
passed`), which is what stops a broken control from reading as a proof.
