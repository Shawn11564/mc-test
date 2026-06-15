# OpenRegions — canonical "regions" SUT (mod / client-GUI form)

Minimal Fabric **client** mod that backs the canonical `regions` test in its **client-GUI** form —
the variant a headless bot provably **cannot** see. `/or` (a CLIENT command) opens a real client
`Screen` titled **Regions** with a **Regions** button → a **Regions** list with a **TestRegion**
entry. Clicking **TestRegion** prints `Region loaded: TestRegion` to the client chat HUD.

This is the deliberate **negative control** for capability negotiation: these are real
`ClickableWidget`s in a client `Screen`, so only the **in-process client driver** (`driver:
inprocess`, advertising `clientScreens`) can inspect/click them. On a headless Paper target the
same `regions.clientgui.mctest.yml` suite is **skipped with a reason** (`unmet:["clientScreens"]`)
— honest skip, not a false green. The chest-menu plugin variant (`../plugin`) is the headless half.

## Canonical testIds (match the plugin exactly)

Widgets implement `io.mctest.agent.core.client.TestIdHolder` (`String mcTestId()`), the client
analog of the server SPIs. The client agent reads these for robust selection:

| Widget | `mcTestId()` | Screen |
|---|---|---|
| "Regions" button | `regions:root:regions` | `RegionsScreen` (root) |
| "TestRegion" entry | `regions:entry:TestRegion` | `RegionsListScreen` (list) |

Note the **colons**, not dots — these are the `PROTOCOL.md`-canonical spellings, identical to the
ids the plugin stamps onto its inventory items (`mc-test:test_id` PDC). A test selects by visible
label OR by testId; the canonical client suite uses testId for robustness.

## The two halves of the assertion

| Half | Owner | M4 status |
|---|---|---|
| Chat: "Region loaded: TestRegion" | this mod (client chat HUD) | runs (driven by the GUI click) |
| Server-truth: region "TestRegion" exists | a **server agent** (`server-fabric`, M5) | honest-skips `unmet:[pluginState]` until M5 |

The client mod only owns the GUI + chat surface; it cannot author authoritative server state (a
client mod has no business doing so). Pair it with a server agent for the real `truth.assertPluginState`.

## Build (ACCEPTANCE-ONLY)

> **This build does NOT run in this repo's offline CI.** Fabric Loom requires network access plus a
> Minecraft/Yarn download, so — exactly like `agents/client-fabric` — the sources are written
> correctly and verified by inspection here; the jar is produced on a provisioned machine. It is a
> **standalone** Gradle build (its own `settings.gradle.kts`), intentionally NOT added to
> `agents/settings.gradle.kts`, so `gradle :core:build :server-bukkit:build` stays offline-clean.

`TestIdHolder` is consumed from the local Maven repository (`io.mctest:mc-test-agent-core:0.1.0`,
the SAME coordinate the plugin's `pom.xml` uses), so the agent core must be published first:

```bash
# 1. publish the agent core SPI/marker to ~/.m2 (Component A / agents/)
cd agents
gradle :core:publishToMavenLocal           # → io.mctest:mc-test-agent-core:0.1.0

# 2. build this mod (Loom; resolves TestIdHolder from mavenLocal) — needs network + a display profile
cd ../examples/regions/mod
gradle build                                # → build/libs/openregions.jar
```

`TestIdHolder` is `compileOnly` (provided): at runtime the client-fabric agent's bundled core owns
`io.mctest.agent.core.client.*`, so this mod does **not** ship its own copy.

## How it pairs in the matrix

`mc-test.yml`'s `fabric-1.21-client` target (`driver: inprocess`) injects `build/libs/openregions.jar`
into the rendered client's `mods/` alongside the `client-fabric` agent jar. The runner launches the
client offline under a display (Xvfb in CI / desktop runner), the client agent connects to the
target server, and the `regions.clientgui.mctest.yml` steps drive `/or` → click `regions:root:regions`
→ click `regions:entry:TestRegion` → `assertChat "Region loaded"`.
