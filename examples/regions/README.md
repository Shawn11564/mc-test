# examples/regions — the canonical SUT + test

`OpenRegions` is the minimal "regions" system-under-test. `/or` opens a
server-driven chest GUI with a **Regions** button; clicking it opens a list with
a **TestRegion** entry; clicking that prints **"Region loaded: TestRegion"** to
chat. This is exactly the flow the canonical test drives — once, across drivers.

## Layout

| Path | What |
|------|------|
| `plugin/` | The Bukkit/Paper plugin (id `OpenRegions`). Build with Maven. |
| `world-snapshot/` | Pristine world copied per test (empty ⇒ Paper generates superflat). |
| `regions.mctest.yml` | The canonical test as a YAML step file. |
| `regions.fluent.test.ts` | The same test in the fluent API (+ a `≡ YAML` assertion). |

## Build the plugin

```bash
mvn -B -f examples/regions/plugin/pom.xml package
# → examples/regions/plugin/target/regions-plugin.jar
```

## Run the test (real Paper boot, headless bot)

From the repo root (after `npm install` and building the packages):

```bash
npx mc-test run examples/regions/regions.mctest.yml --target paper-1.20.4
```

The runner downloads Paper 1.20.4, boots it `online-mode=false` on a loopback
port, drops the plugin in, joins with a Mineflayer bot, runs `/or`, clicks
**Regions** then **TestRegion**, asserts chat contains "Region loaded", and
writes JUnit XML to `mc-test-report/junit/results.xml`. The `assertPluginState`
step is reported **skipped** (`NO_COMPATIBLE_DRIVER`, `unmet:[pluginState]`) — the
headless driver has no server-truth; that half lands in M3.
