# regions world-snapshot

This directory is the **pristine world snapshot** copied fresh per test by the
runner's provisioner (`docs/ENVIRONMENTS.md §3`).

It is intentionally **empty** of world data: the canonical regions test is a
pure GUI/chat flow (`/or` → click "Regions" → click "TestRegion" → assert chat),
so it needs no hand-built terrain. When this snapshot has no `level.dat`, the
provisioner lets Paper generate a fast **superflat** world (`level-type=flat`),
which keeps the unattended boot quick and deterministic.

To use a real pre-built world instead, drop a `level.dat` (+ `region/`, …) here;
the provisioner will copy it into each fresh instance directory.
