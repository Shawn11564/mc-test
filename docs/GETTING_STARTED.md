# Getting started

This walks you from a clean checkout to a **real Paper server booting and running the
canonical regions test** — then to writing a test for *your own* plugin. Everything here is
the actual, verified flow.

> **Status (v1.0):** the **Paper/Spigot plugin** path is real and CI-gated. Rendered-client
> **mod** GUIs and the full multi-loader matrix are v2 (those targets honestly *skip*). See
> [`V1_PLAN.md`](./V1_PLAN.md).

## 1. Prerequisites

- **Node.js 18+** (the runner/engine).
- **JDK 17+** (21 recommended) — to boot the Minecraft server. Check: `java -version`.
- **Maven** — only to build the bundled example plugin (`mvn -version`).
- **Network** — to download the Paper server jar (cached after first use).
- Run `npx mc-test doctor` any time to check these.

## 2. Build the framework

Distribution (publishing `@mc-test/*` to npm) is still being decided, so for now you build
from the checkout:

```bash
git clone <repo> mc-test && cd mc-test
npm install
npm run build        # builds @mc-test/protocol → drivers → runner, in dependency order
```

## 3. Run the canonical regions test (real Paper boot)

Build the example SUT (the `OpenRegions` plugin) and the server-truth agent once:

```bash
# the server-truth agent (assertPluginState / fixtures) + its SPI in your local Maven repo
gradle -p agents :core:publishToMavenLocal :server-bukkit:jar
# the example plugin jar (the System Under Test)
mvn -f examples/regions/plugin/pom.xml package
```

Now run it:

```bash
npx mc-test run examples/regions/regions.mctest.yml --target paper-1.20.4
```

You should see the bot join, run `/or`, click **Regions → TestRegion**, match the chat line,
and — because `paper-1.20.4` co-selects the `server-bukkit` agent — assert the region
**actually exists in server state**:

```
✓ regions-open-testregion [paper-1.20.4] — PASSED
  ✓ join · ✓ command · ✓ waitForScreen · ✓ click · ✓ click · ✓ assertChat
  ✓ assertPluginState: pluginState regions.exists = true
```

## 4. Read the report

Both land under `./mc-test-report/`:

- **`report.html`** — open in a browser: run totals, the `(test × target)` skip matrix, and a
  per-test step timeline.
- **`junit/results.xml`** — the machine/CI contract (consumed by any JUnit reporter). Skips
  appear as `<skipped>` with a reason.

On failure, an artifacts bundle (server log + step trace) is written under
`mc-test-report/artifacts/<target>/<test>/`.

## 5. Test your own plugin

```bash
cd /path/to/your-plugin
npx mc-test init        # scaffolds mc-test.yml + src/mctest/example.mctest.yml
```

Then:

1. **`mc-test.yml`** — point `plugins[].path` at your built plugin jar; keep
   `agents: [server-bukkit]` if you want `assertPluginState`/fixtures.
2. **`src/mctest/example.mctest.yml`** — write your steps (see [`AUTHORING.md`](./AUTHORING.md)
   for the verb + selector + capability reference).
3. Run: `npx mc-test run src/mctest/example.mctest.yml --target paper-1.20.4`.

**Using Gradle / IntelliJ?** Apply the front-door plugin and run `./gradlew mcTest` — it
builds your jar, boots an ephemeral server, and runs your tests, with no manual jar paths.
See [`../gradle-plugin/README.md`](../gradle-plugin/README.md).

## 6. Run it in CI (and host the report)

Scaffold a GitHub Actions workflow that builds your jar, runs your tests across the matrix on
every push/PR, and publishes `report.html` as a workflow artifact + to GitHub Pages:

```bash
npx mc-test init-ci        # or: ./gradlew mcTestInitCi   (writes .github/workflows/mc-test.yml)
```

One-time, to host on Pages: repo **Settings → Pages → Source: "GitHub Actions"** (the report is
uploaded as a downloadable artifact regardless). Full reference: [`CI.md`](./CI.md).

## 7. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `npx mc-test` → "command not found" / no output | Run `npm run build` first (the CLI is built to `dist/`). |
| `EULA_NOT_ACCEPTED` | Set `provision.eulaAccepted: true` in `mc-test.yml` (you accept Mojang's EULA). |
| `agent jar not found` | Build it: `gradle -p agents :server-bukkit:jar`. Or drop `agents:` (the truth steps then honestly skip). |
| `assertPluginState … SKIPPED unmet=[pluginState]` | No server agent co-selected — add `agents: [server-bukkit]` to the target. |
| `plugin not found … build the SUT first` | Build your plugin jar and point `plugins[].path` at it. |
| `UNSUPPORTED_TARGET` / `VIA_BRIDGE_UNAVAILABLE` (old versions) | Expected in v1.0 — legacy (e.g. 1.8.x) + ViaProxy bridging are post-v1.0; the cell honestly skips. See [`ENVIRONMENTS.md`](./ENVIRONMENTS.md). |
| Boot is slow the first time | The Paper jar downloads once into `~/.mc-test/cache`; later runs reuse it. |

Next: [`AUTHORING.md`](./AUTHORING.md) (write tests) · [`ENVIRONMENTS.md`](./ENVIRONMENTS.md)
(the matrix) · [`CI.md`](./CI.md) (CI + host the report) · [`UPGRADING.md`](./UPGRADING.md)
(version migration) · [`ARCHITECTURE.md`](./ARCHITECTURE.md) (how it works).
