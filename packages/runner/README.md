# @mc-test/runner

The **mc-test runner** — the MCTP client/orchestrator and the `mc-test` CLI. It
loads tests (YAML or fluent), selects a driver by capability, provisions a real
server, runs the steps over MCTP, and writes JUnit XML.

## CLI

```bash
mc-test run <stepfile.mctest.yml> --target <id> [--matrix mc-test.yml] [--out dir]
mc-test list    [--matrix mc-test.yml]
mc-test doctor  [--matrix mc-test.yml]
mc-test init    [--dir <dir>]          # scaffold mc-test.yml + a sample test
mc-test init-ci [--dir <dir>] [--standalone]   # scaffold a GitHub Actions workflow (see docs/CI.md)
mc-test clean   [--all] [--runtime] [--dry-run]   # reclaim .mc-test/run
```

The canonical M2 run (boots Paper, joins headless, clicks through, asserts chat):

```bash
npx mc-test run examples/regions/regions.mctest.yml --target paper-1.20.4
```

## What it does

```
load matrix + steps → select driver (capability negotiation) → provision Paper
   → start driver (MCTP server) → MctpClient connects → session.create
   → run steps (step→MCTP, SelectorWaits, per-step honest skips) → JUnit + artifacts
   → teardown
```

- **Capability-driven selection.** `DriverRegistry` + `matchCapabilities`
  (from `@mc-test/protocol`) pick the cheapest driver whose advertised set
  satisfies the test's `requires`; nothing fits → `NO_COMPATIBLE_DRIVER` skip.
  There is **no hard-coded "use headless"** branch.
- **Step → MCTP.** `join→world.join`, `command→world.runCommand`,
  `waitForScreen→screen.waitForScreen`, `click→screen.clickElement` (wrapped by
  `SelectorWaits`), `assertChat→world.waitForChat`,
  `assertPluginState→truth.assertPluginState`, … (`StepExecutor.ts`).
- **Honest per-step skips.** A step whose required capability the driver does
  not advertise (e.g. `assertPluginState` needs `pluginState`) is reported
  `skipped` with `NO_COMPATIBLE_DRIVER` — the test stays green and a companion
  `<testcase>` makes the skip visible in CI.
- **SelectorWaits.** Every selector-bearing step polls/retries on
  `ELEMENT_NOT_FOUND` (intervalMs 250, timeoutMs 5000 by default) in the
  *runner*, never the agent.
- **Minimal provisioning** (`PaperProvisioner`): download a Paper jar (PaperMC
  fill API), write `eula.txt` + offline `server.properties`, copy the world
  snapshot per test, drop the plugin, boot, wait for "Done", tear down.

## Authoring (write once)

YAML (`*.mctest.yml`) and the fluent API compile to the **same** internal
`NormalizedTest`, so they run identically:

```ts
import { test } from "@mc-test/runner";

test("regions-open-testregion")
  .requires({ command: true, containerGui: true })
  .join({ host: "localhost", port: 25565, username: "Tester" })
  .command("or")
  .waitForScreen({ titleContains: "OpenRegions" })
  .click({ label: "Regions" })
  .click({ label: "TestRegion" })
  .assertChat({ contains: "Region loaded" })
  .assertPluginState({ requires: { pluginState: true }, plugin: "OpenRegions",
    query: "regions.exists", args: { name: "TestRegion" }, expect: true });
```

## Testing without a boot

`test/mockAgent.ts` is a scripted in-repo MCTP server; `test/e2e.test.ts` drives
the whole engine against it (capability match → step→MCTP → SelectorWaits →
JUnit), including the mutation negative control and the fluent≡YAML identity —
no Minecraft required.
