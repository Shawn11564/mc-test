# mc-test — Environments & Provisioning (`mc-test.yml`)

> **Scope of this document.** This is the authoritative spec for the **declarative
> environment matrix** (`mc-test.yml`), the **provisioning pipeline** that turns each
> matrix row into a live, isolated System-Under-Test (SUT), the **world fixture / reset
> strategy**, and the **rendered-client** execution story (Xvfb / desktop runner /
> Docker) including the offline-auth note.
>
> It is consumed by `/packages/runner` (the TypeScript orchestrator). The runner reads
> `mc-test.yml`, expands it into concrete **target instances**, provisions each one,
> hands a live MCTP endpoint to the selected driver, runs the suite, and tears the
> instance down.
>
> **Where this sits in the architecture.** The matrix names *what to test against*; the
> [MCTP protocol](./PROTOCOL.md) is the stable contract every driver speaks; the
> [drivers](./DRIVERS.md) are swappable backends chosen by **capability negotiation**.
> This document never talks about test *steps* — only about standing up the world those
> steps run in. Authoring lives in [AUTHORING.md](./AUTHORING.md).

---

## 0. Mental model

```
mc-test.yml ──▶ runner: expand matrix ──▶ for each TARGET INSTANCE:
                                              1. resolve versions (manifest lookups)
                                              2. provision (download + install + world)
                                              3. boot (offline-mode, allocated port)
                                              4. wait for MCTP ready  ◀── agent handshake
                                              5. negotiate capabilities, pick driver
                                              6. run suite over MCTP
                                              7. collect artifacts
                                              8. teardown + reclaim port
```

A **target** (one entry under `targets:`) is a *template*. After matrix expansion
(`matrix:` axes × explicit `targets:`) it yields one or more **target instances**, each
of which is provisioned into its own **run directory** (a.k.a. *instance dir*) and given
its own TCP port(s). Instances are mutually isolated, so many run in parallel.

The canonical example used throughout this doc is the **regions** plugin/mod: `/or` opens
a GUI with a **"Regions"** button leading to entries like **"TestRegion"**; the test
asserts chat contains `Region loaded` and (via the server agent) that region `TestRegion`
exists. See [`/examples/regions`](../examples/regions).

---

## 1. The target-matrix schema

`mc-test.yml` is a YAML document with this top-level shape. **Every field below is
specified with its type, whether it is required, its default, and its meaning.** Unknown
keys are a hard error (the loader validates against the JSON Schema published at
`/packages/protocol/schema/mc-test.schema.json`, `$id`
`https://mc-test.dev/schema/mc-test.yml`).

```yaml
version: 1                 # schema version (int, REQUIRED)
defaults: { … }            # TargetDefaults — merged under every target (optional)
matrix:   { … }            # MatrixAxes — cartesian expansion (optional)
sources:  { … }            # named artifact sources reused by ref (optional)
worlds:   { … }            # named world snapshots reused by ref (optional)
targets:  [ … ]            # list<Target> — REQUIRED, ≥1
suites:   [ … ]            # list<SuiteBinding> — which tests run where (optional)
provision:{ … }            # ProvisionPolicy — global provisioning knobs (optional)
reporting:{ … }            # ReportingPolicy — artifacts/JUnit output (optional)
```

### 1.1 Top-level keys

| Key | Type | Req | Default | Meaning |
|-----|------|-----|---------|---------|
| `version` | int | ✅ | — | Matrix-file schema version. Current is `1`. The loader refuses unknown majors. |
| `defaults` | `TargetDefaults` | — | `{}` | Shallow-then-deep-merged **under** every expanded target. A target's own keys win. Lets you set, e.g., `online-mode`, `jvm`, `provision` once. |
| `matrix` | `MatrixAxes` | — | `{}` | Declares expansion axes (e.g. `mc: [1.20.4, 1.21.4]`). Expanded against each `targets[]` entry that opts in via `useMatrix`. |
| `sources` | map<string,`Source`> | — | `{}` | Named, reusable artifact sources (server jar, loader, plugins, mods, agents) referenceable by `ref:` from any target. DRY for the SUT and agent jars. |
| `worlds` | map<string,`World`> | — | `{}` | Named, reusable world snapshots referenceable by `world: { ref: … }`. |
| `targets` | list<`Target`> | ✅ | — | The matrix rows. Each is a template expanded by `matrix` (when `useMatrix` lists axes) into one or more **target instances**. |
| `suites` | list<`SuiteBinding`> | — | bind-all | Maps test suites/tags to the targets they should run on, and declares each suite's **required capabilities**. If omitted, every discovered suite runs on every target whose capabilities satisfy the suite. |
| `provision` | `ProvisionPolicy` | — | see §2 | Global provisioning behavior: cache dir, parallelism, port range, timeouts, EULA. |
| `reporting` | `ReportingPolicy` | — | see §6 | Where JUnit XML and artifacts land, and what to capture on pass/fail. |

---

### 1.2 `Target`

A target fully describes one place to run tests. Required keys are marked ✅.

| Key | Type | Req | Default | Meaning |
|-----|------|-----|---------|---------|
| `id` | string | ✅ | — | Stable, unique target identifier (slug: `^[a-z0-9][a-z0-9._-]*$`). Appears in report names and instance dir paths. After matrix expansion the instance id is `<id>@<loader>-<mc>-<driver>` (collisions are an error). |
| `loader` | `Loader` enum | ✅ | — | Server/client platform family. One of: `paper`, `spigot`, `folia`, `fabric`, `forge`, `neoforge`, `quilt`, `vanilla`. Determines which installer path §2.3 runs and which agent variant is required. |
| `mc` | `McVersion` (string) | ✅ | — | Target Minecraft version, e.g. `1.20.4`, `1.21.4`. Semver-ish `MAJOR.MINOR[.PATCH]`. Snapshots allowed as `24w39a`-style ids when `loader: vanilla`/`fabric`. |
| `side` | `Side` enum | — | inferred | `server`, `client`, or `both`. Inferred from `driver` when omitted (`headless` or a `server` driver ⇒ `server`; `inprocess`/`pixel` ⇒ `client`+`server`). Controls whether a rendered client is launched (§5). |
| `driver` | `DriverId` enum | — | auto | Preferred driver: `headless`, `inprocess`, `server`, `pixel`, or `auto` (the `DriverId` set in `@mc-test/protocol`). `auto` lets capability negotiation pick (§4). An explicit driver still must satisfy the suite's required caps or the target is **skipped with a reason**. The `pixel` driver (`@mc-test/driver-pixel`) is a selectable last-resort candidate as of **M5** (§4). Note: `server-bukkit`/`server-fabric` are **agent** ids (co-selected via `agents:`), not driver ids. |
| `via` | bool | — | `false` | **v1.0: declared but not yet honored — `via: true` honest-SKIPS** the target with reason `VIA_BRIDGE_UNAVAILABLE`. The headless path connects at the server's native version directly; ViaVersion/ViaProxy bridging of old protocols is **not implemented in this build**, so the runner skips (with a precise reason in the skip matrix) rather than emit a dubious pass. *Intended:* route the headless bot through an offline ViaProxy in front of an old MC server (e.g. `paper-1.8.9`). See the old-version note below the table. |
| `useMatrix` | list<string> | — | `[]` | Names of `matrix` axes this target expands over. Empty ⇒ the target is taken verbatim (one instance). E.g. `[mc]` expands the target once per `matrix.mc` value. |
| `server` | `Source` \| `{ref}` | cond | — | The server artifact (jar/installer) for server-side loaders (`paper`, `spigot`, `folia`, server-side `fabric`/`forge`/`neoforge`/`quilt`, `vanilla`). REQUIRED when `side` includes `server`. May be `{ ref: <sources key> }`. |
| `client` | `Source` \| `{ref}` | cond | — | The client artifact / launch profile for rendered-client targets. REQUIRED when `side` includes `client` and `driver: inprocess|pixel`. See §5.2. |
| `loaderInstaller` | `Source` \| `{ref}` | cond | — | For mod loaders, the loader installer (e.g. Fabric installer jar, NeoForge installer). REQUIRED for `fabric`/`forge`/`neoforge`/`quilt` unless `server`/`client` already points at a pre-installed server jar. |
| `plugins` | list<`Source`\|`{ref}`> | — | `[]` | Bukkit/Spigot/Paper **plugins** to install (the SUT and its deps). Dropped into `plugins/`. The regions plugin is one of these. |
| `mods` | list<`Source`\|`{ref}`> | — | `[]` | Fabric/Forge/NeoForge/Quilt **mods** to install (the SUT and its deps). Dropped into `mods/`. The regions mod is one of these. For an `inprocess` (rendered-client) target these mods are installed into the **rendered client's** `mods/` (§5.2) alongside the client agent (§2.4.2). The regions client-GUI mod is one of these. |
| `display` | `Display` enum | — | from `provision.display` | Per-target display backend for a rendered (`inprocess`/`pixel`) client: `xvfb` (Linux headless / CI) or `desktop` (a real display). Overrides the global `provision.display.backend` (§5.1) for this target only. Ignored for headless/server-side targets (no rendered client). |
| `agents` | list<`AgentId`> | — | inferred from `driver`/`side` | The set of mc-test agents co-installed and **co-selected** for this target. Each entry is a known agent id — `server-bukkit`, `server-fabric`, `client-fabric`, `client-forge`, `client-neoforge` (resolved via `agentResolver`, §2.4; per-agent build/scaffold status is the rightmost column of that §2.4 table — `server-fabric`/`client-forge`/`client-neoforge` are **scaffolded (M5, acceptance-only)**); a per-agent artifact override may be supplied out-of-band via `agentSources` (keyed by agent id). When `agents` is omitted the runner infers them from `driver`/`side`. Listing `server-bukkit` on a Paper target installs the server agent and gives the test the server-owned capabilities (`worldTruth`, `pluginState`, `fixtures`, `fakePlayers`) over a **second MCTP connection** (§2.4.1, §4). Example: `agents: [ server-bukkit ]`. A client target typically lists both a client and a server agent, e.g. `agents: [ client-fabric, server-fabric ]`. |
| `world` | `World`\|`{ref}` | — | `flat-void` builtin | The world snapshot copied **fresh per test** (§3). May be a named ref. |
| `serverProps` | map<string,scalar> | — | see §2.6 | Overrides merged into `server.properties` after the framework-enforced keys. Cannot override `online-mode`, `query.port`, `server-port` (those are owned by the runner). |
| `online-mode` | bool | — | `false` | **Forced to `false`** by the framework for all booted servers (offline auth, §5.4). Exposed only so a suite can *assert* on it; setting `true` is rejected by the loader. |
| `jvm` | `JvmOptions` | — | see §2.7 | Java selection + flags for this target's server/client process. |
| `capabilities` | `CapabilityHints` | — | `{}` | Manual capability **overrides/additions** advertised on this target's behalf (rarely needed — drivers self-advertise). Used to *force-disable* a cap (e.g. `screenshot: false` on a headless CI box). |
| `ports` | `PortRequest` | — | auto | Fixed/override port hints. Normally omitted so the runner allocates from the pool (§2.5). |
| `env` | map<string,string> | — | `{}` | Extra environment variables for the booted process(es). |
| `timeoutSec` | int | — | `300` | Per-instance boot+ready budget. Exceeding it fails the instance with `BOOT_TIMEOUT`. |
| `tags` | list<string> | — | `[]` | Free-form labels used by `suites[].targets` selectors and CLI `--target-tag` filters (e.g. `ci`, `gui`, `slow`). |

> **`Source` vs `{ref}`.** Anywhere a `Source` is accepted you may instead write
> `{ ref: <key> }` to point at an entry under top-level `sources:`. This keeps the big
> URL/coordinate blobs in one place.

> **Old-version targets (v1.0 honest skips).** A target whose `mc` the PaperMC fill API
> cannot serve (e.g. `1.8.x`) **and** that lists `plugins:` is **skipped, not booted**: the
> runner refuses to fall back to a vanilla server (which cannot load Bukkit plugins) and
> reports `UNSUPPORTED_TARGET` rather than failing every plugin step. Combined with the `via`
> skip above, old-version rows surface as honest `○` cells in the skip matrix with a precise
> reason — never a false green. Real old-version coverage (legacy-Paper provisioning + Via GUI
> bridging) is post-v1.0.

---

### 1.3 `Source` (artifact descriptor)

A `Source` tells the provisioner **how to obtain one artifact** and **how to verify it**.
Exactly one of `url` / `path` / `maven` / `paper` / `mojang` / `modrinth` / `github`
**must** be set (the *resolver* discriminator).

| Key | Type | Req | Meaning |
|-----|------|-----|---------|
| `kind` | `ArtifactKind` enum | — | `server-jar`, `loader-installer`, `plugin`, `mod`, `agent`, `client-profile`, `world`, `aux`. Hints the install step where the file goes. Inferred from context (e.g. items under `plugins:` default to `plugin`). |
| `url` | string (URL) | one-of | Direct download URL. |
| `path` | string | one-of | Absolute or repo-relative local file/dir. Skips download (good for locally-built SUT/agent jars). |
| `maven` | `MavenCoord` | one-of | `{ repo, group, artifact, version, classifier?, ext? }` — resolved to a download URL. |
| `paper` | `PaperRef` | one-of | `{ project: paper|folia|velocity, version: <mc>, build: latest\|<int> }` — resolved via the **PaperMC v2 fill API** (§2.1). |
| `mojang` | `MojangRef` | one-of | `{ version: <mc>\|latest-release\|latest-snapshot, artifact: server\|client }` — resolved via the **Mojang version manifest** (§2.2). |
| `modrinth` | `ModrinthRef` | one-of | `{ project: <slug>, version?: <id>, loader?, gameVersion? }` — resolved via the Modrinth API to a primary file. Good for third-party plugin/mod deps. |
| `github` | `GithubRef` | one-of | `{ repo: owner/name, release: latest\|<tag>, asset: <glob> }` — resolved to a release asset. |
| `sha256` | string (hex) | — | Expected digest, verified after resolve; mismatch ⇒ `ARTIFACT_CHECKSUM_MISMATCH`. **Required for `url` plugin/mod sources** — an unverified network download is refused with `INTEGRITY_REQUIRED`. Optional (recommended) for `path`. |
| `as` | string (filename) | — | Rename the installed file (e.g. `regions.jar`). Default keeps the source filename. |
| `optional` | bool | — | If `true`, a resolve/download failure is a *warning*, not an error (e.g. an optional companion mod). Default `false`. |

> **v1.0 resolver support.** The runner currently resolves **`path`** and **`url`** plugin/mod
> sources (with `sha256` integrity, §2), plus **`paper`**/**`mojang`** for server jars. `maven`,
> `modrinth`, and `github` are part of the documented schema but **not yet runner-consumed** —
> use `url` + `sha256` for third-party deps until they land. Version pinning (Mineflayer +
> minecraft-data, and a future ViaProxy build) is per-runner-release; a bump is gated by the
> golden E2E so old-version behavior stays reproducible.

---

### 1.4 `World`

| Key | Type | Req | Default | Meaning |
|-----|------|-----|---------|---------|
| `name` | string | — | map key | Logical world name (`world` directory base name in the instance). |
| `snapshot` | `Source`\|`{ref}` | cond | — | A zip/dir snapshot to copy fresh per test. One of `snapshot` / `generate` REQUIRED. |
| `generate` | `WorldGen` | cond | — | Procedural generation instead of a snapshot: `{ type: flat\|void\|default\|amplified\|custom, seed?, presetFlat?, settings? }`. |
| `levelName` | string | — | `world` | Value written to `server.properties:level-name`. |
| `paths` | list<string> | — | `[world, world_nether, world_the_end]` | Which world directories the snapshot/generation covers (Bukkit splits dimensions into sibling dirs; vanilla/Fabric uses `world/DIM*`). The reset strategy (§3) restores exactly these. |
| `resetPolicy` | `ResetPolicy` enum | — | `per-test` | `per-test`, `per-suite`, `per-instance`, or `never`. How often the pristine snapshot is restored (§3). |
| `readOnly` | bool | — | `false` | If `true`, the live world is bind-mounted read-only and writes are redirected to an overlay (fastest reset; §3.3). |
| `datapacks` | list<`Source`\|`{ref}`> | — | `[]` | Datapacks dropped into `<world>/datapacks/` (e.g. a fixture datapack that pre-creates `TestRegion`'s blocks). |

Two **builtin** worlds are always available without declaration:
`flat-void` (a superflat void, fastest boot) and `flat-grass` (one grass layer). Reference
them as `world: { ref: flat-void }`.

---

### 1.5 `MatrixAxes`

A map of axis-name → list of values. Targets opt in via `useMatrix: [axis, …]`. The runner
takes the **cartesian product of the listed axes** for each opting target.

```yaml
matrix:
  mc:     ["1.20.4", "1.21.1", "1.21.4"]   # well-known axis: overrides Target.mc per instance
  driver: ["headless", "inprocess"]         # well-known axis: overrides Target.driver
  # arbitrary axes are allowed and surface as ${{ matrix.<name> }} interpolation tokens
```

Well-known axes (`mc`, `loader`, `driver`, `side`) override the same-named `Target` field
on each expansion. Arbitrary axes are available for string interpolation (§1.9) but do not
auto-bind to fields.

**Exclusions/includes.** Optional sibling keys refine the product:

| Key | Type | Meaning |
|-----|------|---------|
| `exclude` | list<map> | Drop instances matching all key/values, e.g. `- { loader: fabric, driver: server-bukkit }`. |
| `include` | list<map> | Add or patch specific combos after expansion (WebDriver-style), e.g. pin a build for one `(loader,mc)` pair. |

---

### 1.6 `SuiteBinding`

Declares which suites run where and **what capabilities they require** — the input to
capability negotiation (§4).

| Key | Type | Req | Default | Meaning |
|-----|------|-----|---------|---------|
| `id` | string | ✅ | — | Suite id (matches a `*.mctest.yml` step file under `/tests` or `/examples/*`, e.g. `examples/regions/regions.mctest.yml`). |
| `match` | `SuiteSelector` | — | all files | `{ paths?: glob[], tags?: string[] }` — which `*.mctest.yml` step files compose this suite (e.g. `examples/regions/**/*.mctest.yml`). |
| `targets` | `TargetSelector` | — | all | Which targets it runs on: `{ ids?: [...], tags?: [...], loaders?: [...] }`. |
| `requires` | `RequiredCapabilities` | — | `{}` | Capabilities the suite needs; merged with per-test `requires`. The runner skips any target whose negotiated caps don't satisfy this (§4). |
| `parallelism` | int | — | from `provision` | Max concurrent instances for this suite (port budget permitting). |
| `retries` | int | — | `0` | Re-run a *failed* test this many times before marking it failed (flake guard). |

---

### 1.7 `RequiredCapabilities` & `CapabilityHints`

Capabilities are the **negotiated vocabulary** between suites and drivers. Canonical keys
(the full registry lives in [PROTOCOL.md](./PROTOCOL.md) → *Capabilities*):

| Capability key | Type | Meaning (what a driver advertising it can do) |
|----------------|------|-----------------------------------------------|
| `chat` | bool | Send chat / run commands (`/or`) and read chat back. |
| `command` | bool | Issue server commands as a player or console. |
| `containerGui` | bool | Inspect/click **container (chest-style) GUIs** — the headless bot's reach. |
| `clientScreens` | bool | Inspect/click **client-rendered Screens & widgets** (real mod GUIs). Only `inprocess`. |
| `rendering` | bool | A real rendered client exists (frames are drawn). Implies a display (§5). |
| `screenshot` | bool | Capture PNG screenshots of the client. |
| `worldTruth` | bool | Read authoritative world state (`truth.getWorldBlock`, `truth.getEntities`). |
| `pluginState` | bool | Assert plugin/mod internal state (`truth.assertPluginState`) — e.g. region `TestRegion` exists. |
| `fixtures` | bool | Apply/reset server-side fixtures (`fixture.set`, `fixture.reset`). |
| `fakePlayers` | bool | Spawn/despawn server-side fake players (`player.spawnFake`, `player.despawnFake`; Carpet-backed). |
| `testIdTags` | bool | The target emits invisible `testId` carriers the driver/agent can resolve. |

> The `server-bukkit` agent (§2.4.1) advertises exactly `worldTruth`, `pluginState`,
> `fixtures`, `fakePlayers`, `chat`, `testIdTags`. The four world/plugin/fixture/fake-player
> caps are **server-owned**: a UI-driven test obtains them by co-selecting this agent (§4),
> and the requiring steps **skip with a reason** when no agent is present.

- **`RequiredCapabilities`** (on a suite/test): a map of `key: true` (must-have) or
  `key: "optional"` (prefer-but-skip-feature). The negotiator picks the cheapest driver
  whose advertised set ⊇ the must-haves.
- **`CapabilityHints`** (on a target): manual `key: true|false` overrides that *add to* or
  *force-off* what the driver self-advertises. Force-off is the common use (`screenshot:
  false` on a headless box).

> **The canonical regions test** declares `requires: { chat: true, clientScreens: true,
> pluginState: true }` for the *real-mod-GUI* variant — which only the `inprocess` driver
> satisfies — and `requires: { chat: true, containerGui: true, pluginState: true }` for the
> *headless plugin* variant, satisfiable by the `headless` bot + `server-bukkit` agent.

---

### 1.8 `JvmOptions`, `PortRequest`, `ProvisionPolicy`, `ReportingPolicy`

**`JvmOptions`**

| Key | Type | Default | Meaning |
|-----|------|---------|---------|
| `java` | string | auto | JDK to use: a version (`17`, `21`), an alias (`temurin-21`), or an absolute `JAVA_HOME`. The runner enforces the **minimum** for the MC version (≥1.18 ⇒ 17, ≥1.20.5 ⇒ 21) and fails fast if unmet. |
| `xmx` / `xms` | string | `2G` / `1G` | Heap caps. |
| `flags` | list<string> | Aikar's flags | Extra JVM flags (G1 tuning by default). |

**`PortRequest`** — normally omitted; the pool (§2.5) allocates.

| Key | Type | Default | Meaning |
|-----|------|---------|---------|
| `gamePort` | int | auto | Fixed Minecraft `server-port`. |
| `mctpPort` | int | auto | Fixed MCTP WebSocket port the agent listens on. |
| `rconPort` | int | auto/off | RCON port if `rcon: true`. |

**`ProvisionPolicy`** (global, under top-level `provision:`)

| Key | Type | Default | Meaning |
|-----|------|---------|---------|
| `cacheDir` | string | `~/.mc-test/cache` | Content-addressed download cache (keyed by `sha256`/resolved-URL). Shared across runs/instances; never mutated by a running instance. |
| `workDir` | string | `.mc-test/run` | Parent of all per-instance run directories. |
| `parallelism` | int | `min(4, NCPU)` | Max instances provisioned/booted at once. |
| `portRange` | `[int,int]` | `[25700, 25899]` | Inclusive pool the allocator draws `gamePort`/`mctpPort`/`rconPort` from (§2.5). |
| `bindHost` | string | `127.0.0.1` | Interface servers bind to. |
| `eulaAccepted` | bool | `false` | Must be `true` to boot any Mojang server (writes `eula=true`). The runner refuses to boot otherwise — **you accept Mojang's EULA by setting this.** |
| `agentResolver` | `AgentResolver` | builtin | How to find the prebuilt agent per `(loader,mc,side)` when a target omits `agent:` (§2.4). |
| `keepOnFailure` | bool | `true` | Preserve the instance dir + logs when a test fails (for debugging). Passing instances are cleaned unless `keepWorkDir`. |
| `keepWorkDir` | bool | `false` | Never delete instance dirs (debug). |
| `offline` | bool | `false` | Forbid network; require everything already cached. CI air-gap mode. |
| `downloadRetries` | int | `3` | Retry count for transient download/resolve failures (exponential backoff). |

**`ReportingPolicy`** — see §6.

---

### 1.9 String interpolation

Values may reference matrix axes and a small set of builtins via `${{ … }}`:

- `${{ matrix.<axis> }}` — e.g. `as: regions-${{ matrix.mc }}.jar`.
- `${{ target.id }}`, `${{ target.loader }}`, `${{ target.mc }}`.
- `${{ env.NAME }}` — process environment (e.g. tokens, never log them).

Interpolation runs **after** matrix expansion, **before** provisioning.

---

## 2. The provisioning pipeline

The runner provisions each target instance into an isolated **instance directory** and
brings up a live MCTP endpoint. Steps run in this order; any failure aborts the instance
with a typed error and (if `keepOnFailure`) preserves the dir.

```
resolve ▶ download(+verify, cached) ▶ install loader ▶ drop SUT ▶ install agent
        ▶ materialize world ▶ write config (props, eula, port) ▶ boot (offline)
        ▶ await MCTP-ready handshake ▶ ready
```

### 2.1 Resolve — PaperMC (server jar via fill API)

For `loader: paper|folia` (or a `Source.paper`), resolve through the **PaperMC v2 "fill"
API**:

1. `GET https://fill.papermc.io/v3/projects/{project}/versions/{mc}/builds` →
   pick `build: latest` (default) or the pinned integer.
2. From the chosen build, read `downloads.server:default` (or `application`) → its `url`
   and `checksums.sha256`.
3. Cache by sha256 under `provision.cacheDir`; verify on use.

`project` ∈ {`paper`, `folia`, `velocity`}. If a `(project,mc)` has **no** build, that's
`ARTIFACT_NOT_AVAILABLE` (e.g. Folia only exists for newer MC) and the instance is skipped
with that reason.

### 2.2 Resolve — Mojang (vanilla server/client via version manifest)

For `loader: vanilla` and for the **rendered client jar** of any loader, resolve through
the **Mojang piston version manifest**:

1. `GET https://piston-meta.mojang.com/mc/game/version_manifest_v2.json`.
2. Find the entry whose `id == mc` (or `latest.release`/`latest.snapshot` for the aliases)
   → its per-version package `url`.
3. `GET` that package JSON → `downloads.server.url` (+`sha1`) and/or
   `downloads.client.url` (+`sha1`).
4. Cache by sha1; verify on use. (Mojang publishes sha1; Paper publishes sha256 — both are
   honored.)

### 2.3 Install — loader

| Loader | Install action |
|--------|----------------|
| `paper`, `folia` | The downloaded jar **is** the server. No installer; first boot patches itself. |
| `spigot` | If `server` is a BuildTools spec, run BuildTools to produce the jar (cached by `(mc,rev)`); otherwise use the provided/`maven` jar. |
| `vanilla` | Use the Mojang `server.jar` directly. |
| `fabric` | Run the **Fabric installer** (`loaderInstaller`) in `server` mode against `mc` to produce `fabric-server-launch.jar` (+ `server.jar` via Mojang). |
| `forge` / `neoforge` | Run the **(Neo)Forge installer** `--installServer`; capture the generated run script / `@libraries` args jar. |
| `quilt` | Run the **Quilt installer** `install server <mc> --download-server`. |

The exact launch command (plain jar vs. `@args` file vs. generated `run.sh`) is recorded in
the instance's `launch.json` so boot (§2.8) and teardown are loader-agnostic.

### 2.4 Install — SUT and matching agent

1. **SUT.** Copy every `plugins[]` into `<instance>/plugins/` and every `mods[]` into
   `<instance>/mods/` (renaming per `Source.as`). The **regions** SUT is just one of these
   entries — to the framework it is opaque.
2. **Agent (the MCTP server).** If the target sets `agent:`, install it the same way
   (plugin → `plugins/`, mod → `mods/`). Otherwise the `agentResolver` picks the prebuilt
   agent matching `(loader, mc, side)`:

   - **`AgentResolver`** default: look up `agents/<variant>/build/libs/agent-<variant>-<mc>.jar`
     produced by the agent build (`/agents/*`), where `<variant>` maps from `(loader,side)`:

     | loader | side | variant artifact | dir | status |
     |--------|------|------------------|-----|--------|
     | paper/spigot/folia | server | `server-bukkit` | `/agents/server-bukkit` | shipped (M3) |
     | fabric (server) | server | `server-fabric` | `/agents/server-fabric` | scaffolded (M5; acceptance-only Loom/ForgeGradle/NeoGradle build; artifact `agent-server-fabric.jar`) |
     | fabric (client) | client | `client-fabric` | `/agents/client-fabric` | shipped (M4) |
     | forge (client) | client | `client-forge` | `/agents/client-forge` | scaffolded (M5; acceptance-only Loom/ForgeGradle/NeoGradle build; artifact `agent-client-forge.jar`) |
     | neoforge (client) | client | `client-neoforge` | `/agents/client-neoforge` | scaffolded (M5; acceptance-only Loom/ForgeGradle/NeoGradle build; artifact `agent-client-neoforge.jar`) |

   - The agent is the *only* per-version artifact (it carries the Yarn/MCP/Mojmap mappings
     for that `mc`). Resolution can be overridden with
     `provision.agentResolver: { strategy: maven|path|github, … }`.
   - If no agent exists for `(loader,mc,side)`, the instance is **skipped** with
     `AGENT_NOT_AVAILABLE` (clear, actionable: "build `/agents/server-bukkit` for 1.21.4").

The agent is configured (via a generated `mc-test-agent.toml` / `config.yml` in the
instance) to open the MCTP WebSocket on the **allocated `mctpPort`**, bound to
`provision.bindHost`, with a one-time **handshake token** the runner also holds — so only
our runner can drive the instance.

### 2.4.1 The server agent (`server-bukkit`) — install, port, and discovery

When a target's `agents:` list includes the **Bukkit server agent**
(`/agents/server-bukkit`, MCTP `agent.kind: serverPlugin`), provisioning installs and
configures it as follows (M3):

1. **Install.** Drop the agent's **fat plugin jar** into `<instance>/plugins/`. The build
   produces it as `mc-test-agent-bukkit.jar`; the `agentResolver` installs it under the
   canonical per-version name `agent-server-bukkit-<mc>.jar` (§2.4). The jar bundles
   `/agents/core` + Java-WebSocket; Paper provides the Bukkit API and Gson at runtime. Its
   `plugin.yml` declares `name: mc-test-agent`.
2. **Configure its own MCTP port.** The server agent listens on a **second** MCTP
   port — distinct from the game `server-port` and from any UI driver's `mctpPort`. The
   runner allocates it with the same pool allocator (§2.5) and writes it into
   `<instance>/plugins/mc-test-agent/config.yml` as `port: <allocatedAgentPort>`
   (bound to `provision.bindHost`).
3. **Discover the port from the boot log.** On start the agent logs
   **`MCTP listening on :PORT`**. The runner confirms readiness by connecting to the
   allocated agent port and completing `session.create` (TCP connect + handshake within
   `Target.timeoutSec`, else `BOOT_TIMEOUT`); the log line is the human-readable confirmation
   that the agent bound the expected port.
4. **Co-selected two-connection session.** Because the server agent is an **independent**
   MCTP server, a test that needs both a UI surface and server truth runs over **two MCTP
   connections** unified behind one logical session (a `SessionGroup`): the runner fans
   GUI/chat steps to the UI driver connection and `truth.*` / `fixture.*` / `player.*` steps
   to the server-agent connection. The negotiator reasons about the **union** of both
   connections' advertised capabilities (§4). If a target lists no server agent, the
   server-owned requirements are unmet and those steps **skip with a reason** (§4) rather than
   pass.

> The SUT registers its plugin-state probe and region fixtures with the agent via the
> `McTestStateProvider` / `McTestFixtureProvider` SPIs shipped in `/agents/core` — see
> [`DRIVERS.md`](./DRIVERS.md) §3.2.1 and [`ROADMAP.md`](./ROADMAP.md) §4.3. Provisioning does
> not need to know those names; it only drops the jars and wires the port.

### 2.4.2 The client agent (`client-fabric`) — install, launch, and port discovery

When a target uses `driver: inprocess` (a **rendered client**), provisioning installs and
discovers the **client agent** (`/agents/client-fabric`, MCTP `agent.kind: clientMod`) as
follows (M4). This mirrors §2.4.1 but the agent runs **inside the rendered client**, not the
server, and the runner **launches and babysits** that client via `/packages/driver-inprocess`:

1. **Install (into the client's `mods/`).** Resolve the client agent via the `agentResolver`
   (§2.4) — `agents/client-fabric/build/libs/agent-client-fabric-<mc>.jar` (the
   `agent-<variant>-<mc>.jar` convention) — and drop it into the **rendered client's** `mods/`
   directory **alongside the SUT's client mod** (`Target.mods`, materialized via the client
   launch profile `Target.client.mods`, §5.2). The client agent carries the per-`mc`
   Yarn mappings (the only per-version artifact); if none exists for `(fabric, mc, client)`
   the instance is **skipped** with `AGENT_NOT_AVAILABLE` (§8).
2. **Launch & babysit the client.** Unlike the server agent (which only *listens* inside the
   already-booted server JVM), the rendered client is **started by `driver-inprocess`**: it
   selects the display backend (`Target.display` → `xvfb` / `desktop`, §5.1), builds an
   **offline** client launch (no Microsoft auth: `--username Tester --uuid <…> --accessToken 0`),
   injects the SUT mod + client agent jar and the `MCTEST_AGENT_PORT` environment variable, and
   spawns the client into that display. The client then auto-`connect`s to the instance's server
   `gamePort` (§5.2).
3. **Discover the port from the client log.** On start the client agent logs
   **`MCTP listening on :PORT`** to the client's stdout/`client.log`. `driver-inprocess`
   **scrapes** that line (`/MCTP listening on :(\d+)/`) to learn the agent's WebSocket port and
   dials `ws://<bindHost>:PORT` to complete `session.create` (TCP connect + handshake within
   `Target.timeoutSec`, else `BOOT_TIMEOUT`). The agent port may be pinned via
   `MCTEST_AGENT_PORT` / `PortRequest.mctpPort` or left to the pool allocator (§2.5).
4. **Co-selected two-connection session.** Exactly as in §2.4.1: a client-GUI test that also
   needs server truth runs over **two MCTP connections** behind one logical session — the runner
   fans `screen.*` / chat / command steps to the **client-agent** connection and
   `truth.*` / `fixture.*` / `player.*` steps to a co-installed **server** agent
   (`server-bukkit`/`server-fabric`). The negotiator reasons about the **union** of both
   connections' advertised caps (§4). With no server agent listed, the server-owned steps
   **skip with a reason** (§4) rather than pass.

> The SUT's cooperating client mod stamps stable widget `testId`s the client agent reads via the
> `TestIdHolder` marker shipped in `/agents/core` (the client analog of the server SPIs) — see
> [`PROTOCOL.md`](./PROTOCOL.md) §7.3.2, [`DRIVERS.md`](./DRIVERS.md) §2.2, and
> [`ROADMAP.md`](./ROADMAP.md) §5.3. Provisioning does not need to know those ids; it only drops
> the jars, launches the client, and scrapes the port.

### 2.5 Allocate ports (parallelism)

Each instance needs ≥2 free TCP ports: `gamePort` (Minecraft `server-port`) and `mctpPort`
(the UI driver / primary agent WebSocket); `+rconPort` if RCON is enabled. When the target
also co-installs a **server agent** (§2.4.1), the runner allocates an **additional** MCTP
port for it (distinct from `gamePort` and the UI `mctpPort`), so a co-selected GUI+truth
target uses ≥3 ports.

- The allocator hands out ports from `provision.portRange`, skipping any already bound
  (probes `bind()` on `bindHost`) and any reserved by a live instance.
- Ports are **leased** for the instance's lifetime and returned on teardown, so a long run
  reuses the range.
- `Target.ports`/`PortRequest` can pin specific ports (e.g. to attach a debugger); pins are
  validated for availability and excluded from the pool.
- Because every instance has its **own** ports + **own** instance dir + **own** world copy,
  N instances run fully in parallel up to `provision.parallelism`.

### 2.6 Materialize world

Per the world's `resetPolicy` (§3), copy the pristine snapshot (or generate) into
`<instance>/<levelName>/` (+ sibling dimension dirs from `World.paths`). Drop `datapacks[]`
into `<world>/datapacks/`. This is the **fresh, isolated** world the test mutates.

### 2.7 Write configuration

The runner writes, in the instance dir:

- **`eula.txt`** → `eula=true` **iff** `provision.eulaAccepted: true` (else refuse to boot).
- **`server.properties`** → start from a minimal template, apply `Target.serverProps`, then
  **force** the runner-owned keys (these always win and cannot be overridden):

  | Key | Forced value | Why |
  |-----|--------------|-----|
  | `online-mode` | `false` | Offline auth — no Microsoft login in CI (§5.4). |
  | `server-port` | allocated `gamePort` | Parallel isolation. |
  | `server-ip` | `provision.bindHost` | Bind locally. |
  | `enable-rcon` / `rcon.port` | from `PortRequest` | Only if requested. |
  | `level-name` | `World.levelName` | Point at the fresh world. |
  | `level-type` / `generator-settings` | from `World.generate` | Procedural worlds. |
  | `spawn-protection` | `0` | Let fixtures/fake-players act at spawn. |
  | `sync-chunk-writes` | `true` | Deterministic world state for assertions. |

- **`ops.json`** / `whitelist` as needed so fake players and the bot have permissions for
  `/or` and fixtures.
- For mod loaders, the loader's `config/` defaults plus the agent's generated config.

### 2.8 Boot (offline-mode) & await ready

1. Launch via the recorded `launch.json` (`java <jvm flags> -jar <serverjar> nogui`, or the
   loader's run script), with `cwd = <instance>`, `env = defaults.env + target.env`, stdout/
   stderr teed to `<instance>/logs/server.log`.
2. The runner **waits for MCTP-ready**, not just for "Done!" in the log: the agent, once its
   plugin/mod loads, **dials nothing** — it *listens* on `mctpPort`; the runner connects,
   completes the JSON-RPC handshake (`session.create` with the token, capability advertisement),
   and only then considers the instance **ready**. Health gate = TCP connect + successful
   `session.create` within `Target.timeoutSec` (else `BOOT_TIMEOUT`).
3. For rendered-client targets, the client is launched and brought up under a display
   (§5) and performs the same handshake from the in-process client agent.

### 2.9 Teardown

Graceful `stop`/`/stop` (or MCTP `session.close`), wait, then SIGKILL on timeout. Return
leased ports. Delete the instance dir unless `keepOnFailure` (and the test failed) or
`keepWorkDir`. Always flush artifacts (§6) **before** deletion.

---

## 3. World fixture & reset strategy

Tests must start from a **known world** and must not leak state into each other. The
framework guarantees isolation three ways, chosen by `World.resetPolicy` + `World.readOnly`.

### 3.1 Pristine snapshot, copied fresh

The **pristine snapshot** (`World.snapshot`, e.g. a zip in `/examples/regions/world`) lives
in the cache, **never mutated**. The live world under `<instance>/<levelName>/` is a *copy*.
`resetPolicy` controls how often that copy is re-made from pristine:

| `resetPolicy` | Re-copy pristine… | Use when |
|---------------|-------------------|----------|
| `per-test` (default) | before **every** test | Maximum isolation; tests mutate blocks/entities. |
| `per-suite` | once per suite | Tests within a suite are read-only or additive and order-independent. |
| `per-instance` | once at boot | Fast; tests don't disturb the world (pure GUI/chat assertions). |
| `never` | never (use as-is) | Snapshot is authoritative and immutable. |

### 3.2 In-place reset between tests (fast path)

For `per-test` without a full re-copy, the runner can do an **in-place restore**: before a
test it `rsync`/diff-restores only the chunk regions that changed since the pristine copy
(tracked via the snapshot's file hashes), and issues MCTP **fixture** calls to reset
volatile state (`fixture.set(clear-entities)`, time/weather lock). This is the default
optimization when the snapshot is large; semantics are identical to a fresh copy.

### 3.3 Copy-on-write / read-only overlay (fastest)

When `World.readOnly: true`, the pristine world is mounted **read-only** and the server
writes to a throwaway **overlay** (OverlayFS on Linux Docker; a shadow copy elsewhere).
Reset = discard the overlay (O(1)). Ideal for high-parallelism CI where each test only reads
world truth (e.g. "does block at X look right?") and never needs persistent writes.

### 3.4 Fixtures (server-agent setup) vs. world snapshots

Two complementary mechanisms:

- **World snapshot** = the *static* starting terrain/regions (e.g. a pre-built area and a
  datapack that defines `TestRegion`'s bounds).
- **Fixtures** = *dynamic* per-test setup applied over MCTP by the **server agent** before
  the test body: `fixture.set` (place blocks, set a region, give items, set time/weather/
  gamemode), `player.spawnFake` (Carpet-style bot to trigger actions), `truth.assertPluginState`
  (the assertion side). Fixtures are version-independent calls; the agent translates them.

For the **regions** example the recommended setup is: world `flat-void` + a fixture that
calls `fixture.set({ region: "TestRegion", min: [...], max: [...] })` on the regions plugin,
so the test is hermetic and doesn't depend on a hand-built snapshot. The assertion
`truth.assertPluginState({ plugin: "regions", query: "regionExists", args: { name: "TestRegion" }})`
then verifies real runtime state.

### 3.5 Determinism knobs

Independently of reset, the runner locks nondeterminism so assertions are stable:
`doDaylightCycle=false`, `doWeatherCycle=false`, `randomTickSpeed=0` (unless a test opts
in), fixed `--seed` for generated worlds, `spawn-protection=0`, and time/weather set via
fixtures at test start. These are applied through the server agent right after ready.

---

## 4. Capability negotiation & skip-with-reason

This is the Appium-style keystone that decouples *what a test needs* from *what a backend
can do*.

1. After boot, each driver candidate for the target **advertises** its capability set via
   the MCTP handshake (`session.create`), refined by `Target.capabilities`
   force-on/off hints.
2. The suite/test declares `requires` (§1.7).
3. The negotiator selects the **cheapest** driver whose advertised set ⊇ the required
   must-haves (cost order: `server-bukkit`/`server-fabric` < `headless` < `inprocess` <
   `pixel`; cost order is owned by [`CAPABILITIES.md`](./CAPABILITIES.md) §7). `Target.driver`
   (if not `auto`) constrains the candidate set first. As of **M5** the `pixel` driver
   (`@mc-test/driver-pixel`, driver id `pixel`, **cost 4** — the last resort) is a real
   selectable candidate that advertises a boolean cap set + the advisory `brittle: true`
   descriptor (§6.1); selection prefers any cheaper structural driver and chooses `pixel`
   **only** when nothing cheaper fits (or `driver: pixel` is pinned). Its OCR/template +
   OS-input backend is a **stub** (registered purely for negotiation; selection never launches
   it).
3a. **Co-selection (multi-connection).** When the required set spans both UI capabilities and
   **server-owned** ones (`worldTruth`, `pluginState`, `fixtures`, `fakePlayers`), and the
   target's `agents:` includes a server agent (`server-bukkit`/`server-fabric`), the runner
   opens a **second MCTP connection** to that agent and reasons about the **union** of the UI
   driver's and the server agent's advertised caps (§2.4.1). One logical session fans each
   step to the connection that advertises its capability — the test author writes no plumbing.
   If a server-owned cap is required but no server agent is listed, that requirement is unmet.
4. If **no** candidate (or union) satisfies the requirements, the test is **SKIPPED** (not failed) with
   a precise reason, e.g.:
   `SKIP regions/real-mod-gui on paper-1.20.4-headless: requires clientScreens, but driver
   'headless' advertises {chat, command, containerGui, worldTruth, pluginState}. Use an
   'inprocess' client target.`
5. Skips are first-class in reporting (JUnit `<skipped message="…">`), so the matrix honestly
   shows *"plugin tests ran headless; the real-mod-GUI test needs a rendered client."*

---

## 5. Rendered-client story (Xvfb / desktop runner / Docker) + auth

Only targets with `clientScreens`/`rendering`/`screenshot` requirements (the `inprocess` and
`pixel` drivers) need a **real Minecraft client drawing frames**. Everything else
(headless bot + server agent) runs without a GUI and is the fast CI default.

### 5.1 Display backends

| Backend | When | How the runner uses it |
|---------|------|------------------------|
| **Xvfb** (Linux headless / CI) | default for `side: client` in CI | Start `Xvfb :<N> -screen 0 1920x1080x24`; export `DISPLAY=:<N>`; launch the client into it. With LWJGL/OpenGL needing GL, pair with **Mesa software GL** (`LIBGL_ALWAYS_SOFTWARE=1`) or VirtualGL on a GPU box. Screenshots come from the **in-process agent** (`screenshot` primitive grabs the framebuffer), not from X — so no GPU compositor is required. |
| **Desktop CI runner** | when a real GPU/display exists (self-hosted, macOS/Windows agents) | Launch the client on the live display. Fastest, most faithful rendering; used for golden-image/pixel tests. |
| **Docker** | reproducibility | A `mc-test/client:<mc>` image bundles a JRE, Mesa, Xvfb, and the loader; the runner runs the client container, mounts the instance dir, and connects MCTP over the published `mctpPort`. Server instances likewise use `mc-test/server:<mc>` images. |

`provision`-level display config (chosen automatically, overridable):

```yaml
provision:
  display:
    backend: auto        # auto | xvfb | host | docker
    resolution: 1920x1080
    depth: 24
    softwareGl: true     # LIBGL_ALWAYS_SOFTWARE for Xvfb/Mesa
    xvfbArgs: ["-ac", "+extension", "GLX"]
```

A per-target `display: xvfb|desktop` (§1.2) **overrides** `provision.display.backend` for that
target only — the common case for an `inprocess` row (e.g. `display: xvfb` on a Linux-CI mod
target). As of **M4**, `/packages/driver-inprocess` owns the backend selection (Linux→`xvfb` with
`DISPLAY` + `LIBGL_ALWAYS_SOFTWARE`; win32/macOS→`desktop`; an explicit `display` wins) and the
client **launch + log-scrape**: it spawns the offline client into the chosen display and learns the
client agent's MCTP port from the client-log line `MCTP listening on :PORT` (§2.4.2).

### 5.2 Client launch profile (`Target.client`)

For `inprocess`/`pixel` targets, `client` describes how to start the real client:

| Key | Type | Meaning |
|-----|------|---------|
| `profile` | `vanilla\|fabric\|forge\|neoforge\|quilt` | Which client to launch (usually mirrors `loader`). |
| `mc` | string | Client MC version (defaults to `Target.mc`). |
| `mods` | list<`Source`> | Client-side mods incl. the **client agent** (`client-fabric`, …) and the SUT's client mod. |
| `connect` | `auto\|localhost:<port>` | After load, the client auto-connects to this instance's server `gamePort`. `auto` ⇒ the allocated game port. This is how *"join localhost"* is realized. |
| `username` | string | Offline username (default `mc-test-client`); valid because the server is `online-mode=false`. |
| `windowSize` | string | e.g. `1920x1080`. |

The runner installs the client loader + mods into a throwaway client instance dir, launches
it under the chosen display backend, waits for the **client agent** to complete its MCTP
handshake, then issues `connect` so the client joins the server. The test then drives real
Screens (`/or` → click "Regions" → click "TestRegion") through the `clientScreens` primitives.

### 5.3 Headless vs. rendered — cost gate

The matrix is designed so the **same regions test** runs headless (fast, plugin/inventory
GUI) in CI on every push, and the **rendered-client** variant (real mod Screen) runs only on
the labeled `gui` targets / nightly. This is enforced purely by capability negotiation (§4):
no rendered client is ever started for a suite that doesn't require `clientScreens`/
`rendering`/`screenshot`.

### 5.4 Auth note — `online-mode=false`, no Microsoft login

All servers boot with **`online-mode=false`** (forced, §2.7). Consequences and rules:

- **No Microsoft/Mojang authentication** is performed for bots or rendered clients. Offline
  UUIDs are derived from the username (`OfflinePlayer:<name>`), which is deterministic and
  fine for tests.
- The headless bot (Mineflayer) connects with `auth: 'offline'`; the rendered client uses an
  **offline profile** (no real account, no session token).
- Servers bind to `127.0.0.1` (`provision.bindHost`) and are **never exposed** to the
  internet — offline-mode servers must not be reachable publicly. The runner refuses a
  non-loopback `bindHost` unless `provision.allowPublicOfflineServer: true` is explicitly set
  (escape hatch, strongly discouraged).
- ViaVersion/ViaProxy (for the version-spanning headless driver) sit in front of the server
  and also run offline; no auth is added by the proxy.
- `Target.online-mode` exists **only** so a suite can assert the server is offline; setting it
  to `true` is rejected at load time (we cannot satisfy real auth in CI).

---

## 6. Reporting & artifacts

`reporting` (top-level) controls output. Defaults shown.

| Key | Type | Default | Meaning |
|-----|------|---------|---------|
| `outputDir` | string | `./mc-test-report` | Root for all output. |
| `junitXml` | string | `<outputDir>/junit/results.xml` | JUnit XML (one `<testsuite>` per `(suite × target instance)`; skips emit `<skipped>` with the negotiation reason from §4). |
| `artifacts.onFailure` | list | `[server-log, client-log, screenshot, world-diff]` | What to capture when a test fails. |
| `artifacts.onSuccess` | list | `[]` | Usually nothing (keep runs cheap). |
| `artifacts.dir` | string | `<outputDir>/artifacts/<target>/<test>` | Where captures land. |
| `video` | `off\|on-failure\|always` | `off` | Record the rendered client (ffmpeg from the X display / framebuffer); only meaningful for rendered targets. |
| `keepLogsOnSuccess` | bool | `false` | Keep `server.log`/`client.log` even when green. |

Artifacts captured: `server.log`, `client.log` (rendered targets), `screenshot` (from the
`screenshot` primitive at the moment of failure, rendered targets), `world-diff` (changed
region files vs. pristine — invaluable for `worldTruth` assertion failures), and the agent's
MCTP trace (`mctp.jsonl`).

### 6.1 Full-matrix run & skip matrix (M5)

`mc-test run <file> --target all` (or with `--target` omitted) runs the **whole matrix** — every
expanded target instance — in one invocation, aggregates **one** JUnit document (the usual one
`<testsuite>` per `(suite × target instance)`), and prints a `(test × target)` **skip matrix** to
the console: a grid showing which `(test, target)` cells were **skipped** and **why**, as the
machine-readable capability **reason strings** from §4 (e.g. the unmet-cap message naming the missing
`clientScreens`). This makes the honest-skips story (§4, Prime Directive 4) legible at a glance across
the matrix without scraping the XML.

> **`brittle` report note (M5).** `brittle` is an **advisory quality descriptor** advertised by the
> pixel/OCR driver (`@mc-test/driver-pixel`, driver id `pixel`), **not** a matchable capability — a
> test cannot `require` it (it is deliberately excluded from the canonical capability-key set; see
> [PROTOCOL.md](./PROTOCOL.md) → *Capabilities*, like the `loader`/`mcVersionRange` descriptors). When
> the negotiator selects a driver advertising `brittle: true`, the runner emits a **loud report note**
> — to the console and as a JUnit `<property name="brittle" value="true"/>` on the affected
> `<testcase>` (under its `<properties>`, like `loader`/`mc`/`driver`) — flagging that the result came
> from a fragile (pixel/OCR) backend.

---

## 7. End-to-end: the regions example across the matrix

The companion file [`/mc-test.example.yml`](../mc-test.example.yml) is a complete, valid,
commented matrix that:

- Defines **named sources** for the regions SUT (plugin jar + Fabric/NeoForge mod jars) and
  the four agents.
- Spans **Paper + Fabric + NeoForge** across **1.20.4 / 1.21.1 / 1.21.4** via `matrix.mc`.
- Provides **two suites**:
  - `regions-plugin-headless` (requires `chat, containerGui, pluginState`) — runs on the
    **Paper** targets with the `headless` bot + `server-bukkit` agent. CI-fast, no display.
  - `regions-mod-gui` (requires `chat, clientScreens, pluginState`) — runs on the **Fabric**
    and **NeoForge** *client* targets with the `inprocess` driver under Xvfb. Skipped (with a
    reason) on Paper, demonstrating §4.
- Uses world `flat-void` + a fixture (`fixture.set` region create) per §3.4, so the test is
  hermetic; the assertion uses `truth.assertPluginState(regionExists "TestRegion")`.

The semantic test itself ("join localhost → `/or` → click **Regions** → click
**TestRegion** → assert chat contains `Region loaded` AND region exists") is authored once in
`/examples/regions/regions.mctest.yml` and bound to both suites; each driver resolves the **semantic
selectors** (label `Regions`, label `TestRegion`) its own way (bot: container slot
display-name; mod: `ClickableWidget.getMessage`), exactly as the prime directives require.

---

## 8. Error/skip taxonomy (provisioning)

Stable, machine-readable codes surfaced in reports and CLI:

| Code | Meaning |
|------|---------|
| `ARTIFACT_NOT_AVAILABLE` | A resolver found no artifact (e.g. Folia for an old `mc`, Paper build missing). Instance **skipped**. |
| `ARTIFACT_CHECKSUM_MISMATCH` | Downloaded bytes ≠ declared `sha256`/`sha1`. **Fail** (possible tampering). |
| `AGENT_NOT_AVAILABLE` | No agent built for `(loader,mc,side)`. Instance **skipped** with build hint. |
| `LOADER_INSTALL_FAILED` | Loader installer (Fabric/Neo/Quilt/BuildTools) errored. **Fail**. |
| `EULA_NOT_ACCEPTED` | `provision.eulaAccepted` not `true`. **Fail** before boot. |
| `PORT_EXHAUSTED` | No free port in `portRange`. **Fail** (raise the range/parallelism). |
| `BOOT_TIMEOUT` | No MCTP-ready handshake within `timeoutSec`. **Fail**; logs preserved. |
| `CAP_UNSATISFIED` | No driver meets a suite's `requires`. Test **skipped** (§4). |
| `ONLINE_MODE_REJECTED` | A target tried to set `online-mode: true`. **Fail** at load. |

---

## 9. Cross-references

- [PROTOCOL.md](./PROTOCOL.md) — MCTP JSON-RPC methods (`session.create`, `screen.listElements`,
  `screen.clickElement`, `screen.get`, `screen.typeText`, `screen.pressKey`, `screen.screenshot`, `truth.getWorldBlock`,
  `truth.getEntities`, `fixture.set`, `fixture.reset`, `player.spawnFake`, `player.despawnFake`, `truth.assertPluginState`, `session.close`) and
  the canonical **capability registry**.
- [DRIVERS.md](./DRIVERS.md) — the four drivers and their advertised capabilities; the
  `server-bukkit` agent (§3): advertised caps, build-artifact naming, the
  `McTestStateProvider` / `McTestFixtureProvider` SPIs, and the multi-connection session.
- [AUTHORING.md](./AUTHORING.md) — fluent API / YAML steps / record-replay (the *write-once*
  layer).
- [`/examples/regions`](../examples/regions) — the canonical SUT + test this doc references.
