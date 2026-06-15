# OpenRegions — canonical "regions" SUT (plugin form)

Minimal Bukkit/Paper plugin that backs the canonical `regions-open-testregion` test. `/or`
opens a chest GUI titled **OpenRegions** with a **Regions** button → a **Regions** list with a
**TestRegion** entry. Clicking **TestRegion**:

1. sends `Region loaded: TestRegion` to chat (drives the GUI/chat half of the test), **and**
2. adds `"TestRegion"` to an authoritative in-memory `RegionStore` (drives the server-truth half).

Both happen together so the chat assertion and the server-truth assertion agree — and so the
"truth/UI divergence" tester control (chat says loaded, but real state is false) is a genuine red,
not a false green.

## Server-truth SPI (M3)

When the mc-test **server agent** (`mc-test-agent`) is on the server, OpenRegions exposes its real
state to MCTP so the runner's `truth.assertPluginState` / `fixture.set` steps read and mutate actual
plugin state instead of inferring from chat:

| Class | SPI (from `mc-test-agent-core`) | What it does |
|---|---|---|
| `RegionStore` | — | thread-safe in-memory `Set<String>` of region names; the single source of truth. |
| `RegionsStateProvider` | `McTestStateProvider` | `regions.exists {name}` → boolean, `regions.count` → int, `regions.list` → names. Backs `truth.assertPluginState`. |
| `RegionsFixtureProvider` | `McTestFixtureProvider` | `regions.createRegion {name}` / `regions.deleteRegion {name}` mutate the store and return `{regionId, handle}`; `undo(handle)` reverses. Backs `fixture.set` / `fixture.reset`. |

`OpenRegionsPlugin.registerMcTestProviders()` registers both with the Bukkit `ServicesManager`
(`getServicesManager().register(McTestStateProvider.class, …)` and likewise for the fixture provider).
It runs inside a `try/catch(Throwable)` in `onEnable`, so when the agent (and its bundled SPI) is
absent the plugin still enables in **pure-M2 mode** — registration is simply skipped.

So `truth.assertPluginState { query: "regions.exists", args: { name: "TestRegion" }, expect: { equals: true } }`
returns a **real** boolean: `false` until the GUI is driven (or `regions.createRegion` is applied),
`true` afterward.

### Classloader contract (important)

The SPI dependency `io.mctest:mc-test-agent-core` is declared at **`provided`** scope — compiled
against, **not bundled** into `regions-plugin.jar`. Combined with `softdepend: [mc-test-agent]` in
`plugin.yml`, the SUT loads the SPI classes from the **agent plugin's** classloader at runtime. That
guarantees the `Class<McTestStateProvider>` this plugin registers under is identical to the one the
agent looks up — if we bundled our own copy, the `ServicesManager` lookup would miss across
classloaders.

## Build order

`mc-test-agent-core` is consumed from the local Maven repository, so the agent core must be
published **before** this Maven build:

```bash
# 1. publish the agent core SPI to ~/.m2 (Component A / agents/)
cd agents
gradle :core:publishToMavenLocal           # → io.mctest:mc-test-agent-core:0.1.0

# 2. build this plugin (resolves the SPI from mavenLocal)
cd ..
mvn -f examples/regions/plugin/pom.xml clean package   # → target/regions-plugin.jar
```

The output stays `regions-plugin.jar` (`finalName`). It contains **no** `mc-test-agent-core` classes
(provided scope) and no Paper API.
