/**
 * The orchestrator: select a driver by capability, open an MCTP session, run
 * the steps (with per-step honest skips and SelectorWaits), and produce a
 * `TestResult`. Driver selection flows through `DriverRegistry` +
 * `matchCapabilities` — there is no hard-coded "use headless" branch.
 */
import { type Capabilities } from "@mc-test/protocol";
import type { ModLoad } from "../model/result.js";
import { MctpRpcError } from "../drivers/MctpClient.js";
import {
  DriverRegistry,
  type DriverDescriptor,
  type DriverLaunchContext,
} from "../drivers/DriverRegistry.js";
import type { NormalizedTest } from "../model/Step.js";
import type { Outcome, StepResult, TestResult, SkipInfo } from "../model/result.js";
import { SessionGroup, type ConnDef } from "./SessionGroup.js";
import { executeStep, VERB_CAPABILITY, type ExecContext } from "./StepExecutor.js";
import { advertisedKeys, requiredKeys, stepCapMatch } from "./CapabilityMatch.js";
import { tryCaptureOnFailure, type ScreenshotArtifact } from "../report/screenshots.js";
import { artifactDirFor, baselineDirFor } from "../report/Artifacts.js";

/** A live, provisioned target (the server the bot will join). */
export interface ProvisionHandle {
  host: string;
  port: number;
  /** Where the server log lives (for failure artifacts). */
  logPath?: string;
  /**
   * Co-selected server-agent connections this provisioning brought up (M3): the
   * agent jar dropped into `plugins/` listening on a second MCTP port. Forwarded
   * to `runTest` so truth/fixture/player steps fan to the agent.
   */
  agents?: AgentConn[];
  /** Boot-log mod-load detection for a modded-server target (F5), surfaced on the result. */
  modLoad?: ModLoad;
  stop: () => Promise<void>;
  /**
   * Optional post-run cleanup of the instance working dir (F1 hardening). Called
   * after `stop()` with whether the test failed; the provider decides what to
   * keep (e.g. retain the dir on failure when `keepOnFailure`, delete on success
   * to bound disk growth). Absent → nothing is cleaned (mock-agent back-compat).
   */
  cleanup?: (failed: boolean) => Promise<void>;
}

/** Identity of the matrix cell, for reporting. */
export interface TargetMeta {
  target: string;
  loader?: string;
  mc?: string;
  /** Optional driver pin (target.driver). */
  driverPin?: string;
  /**
   * Launch context for drivers that spawn an external process (M4: the
   * in-process driver launches a rendered client). Threaded into
   * `descriptor.create(meta.launch)`; ignored by drivers that need no launch
   * (e.g. headless). Built by the CLI from the target row (`mc`/`loader`/
   * `mods`/`display`/client-agent jar).
   */
  launch?: DriverLaunchContext;
}

/**
 * A co-selected server-agent connection (M3). The runner opens this alongside
 * the driver and fans truth/fixture/player steps to it. Its `advertised` caps
 * join the union used for per-step skip decisions, so steps requiring
 * `worldTruth`/`pluginState`/`fixtures`/`fakePlayers` RUN when an agent is
 * connected and honestly SKIP when none is.
 */
export interface AgentConn {
  url: string;
  advertised: Capabilities;
  /** `agent.kind`, e.g. `"serverPlugin"` (informational; routing is by caps). */
  kind?: string;
}

const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function renderSystemOut(steps: StepResult[]): string {
  return steps
    .map((s) => {
      if (s.outcome === "skipped" && s.skip) {
        return `[${s.index}] ${s.verb}: SKIPPED ${s.skip.reason} unmet=[${s.skip.unmet.join(",")}]`;
      }
      if (s.outcome === "failed") {
        return `[${s.index}] ${s.verb}: FAILED ${s.error?.reason ?? ""} ${s.error?.message ?? ""}`.trim();
      }
      return `[${s.index}] ${s.verb}: ok${s.detail ? ` — ${s.detail}` : ""}`;
    })
    .join("\n");
}

export class Runner {
  constructor(private readonly registry: DriverRegistry) {}

  /** Choose a driver for a test, or explain the skip. */
  selectDriver(
    test: NormalizedTest,
    pin?: string,
  ): { descriptor?: DriverDescriptor; skip?: SkipInfo } {
    const { driver, unmet } = this.registry.select(test.requires, pin);
    if (driver) return { descriptor: driver };
    return {
      skip: {
        category: "capability",
        reason: "NO_COMPATIBLE_DRIVER",
        unmet,
        message: `no driver satisfies required capabilities {${unmet.join(", ")}}`,
      },
    };
  }

  /**
   * Run a test against an already-live MCTP endpoint + provisioned server.
   * This is the protocol-pure core (mock-agent E2E exercises exactly this).
   *
   * When `agents` are supplied, the runner opens a multi-connection
   * `SessionGroup` (driver + each agent) and fans truth/fixture/player steps to
   * the agent. Per-step skip decisions use the **union** of advertised caps, so
   * an `assertPluginState` step runs when an agent is co-connected and honestly
   * skips `unmet:["pluginState"]` when none is (M2 back-compat).
   */
  async runTest(
    test: NormalizedTest,
    descriptor: DriverDescriptor,
    endpointUrl: string,
    exec: ExecContext,
    meta: TargetMeta,
    agents: AgentConn[] = [],
  ): Promise<TestResult> {
    const start = Date.now();
    const steps: StepResult[] = [];
    const group = new SessionGroup();
    let outcome: Outcome = "passed";
    let failure: TestResult["failure"];
    let testSkip: SkipInfo | undefined;
    // Artifact paths produced during the run (step screenshots + on-failure
    // captures), surfaced on the result so the reporter/bundle pick them up.
    const testArtifacts: string[] = [];

    // A driver advertising the advisory `brittle` flag (the pixel/OCR last
    // resort) gets a loud report note so its result is never mistaken for a
    // reliable one. `brittle` is NOT a matchable capability — it affects only the
    // report (ROADMAP §6.3; PROTOCOL.md §6.1).
    const brittle = descriptor.advertised.brittle === true;
    const notes = brittle
      ? [
          `⚠ BRITTLE DRIVER: '${descriptor.id}' (${descriptor.kind}) was selected as the LAST-RESORT visual driver — ` +
            `selectors are resolved by OCR/template over raw pixels, so results may be unreliable. ` +
            `Prefer a structural driver (server/headless/inprocess) where one fits.`,
        ]
      : [];

    const required = requiredKeys(test.requires);
    const constraints = {
      ...(meta.mc ? { mcVersionRange: meta.mc } : {}),
      ...(meta.loader ? { loader: meta.loader } : {}),
    };
    const withConstraints = Object.keys(constraints).length ? { constraints } : {};

    // A co-selected agent is a COMPANION (role "agent"): it must never refuse the
    // session over capabilities. We require nothing and OFFER the assumed caps as
    // optional, then let the union reflect what the agent ACTUALLY grants (capability
    // discovery, not a runner-side assumption). So an agent that honestly advertises a
    // subset — e.g. the bukkit agent dropping `fakePlayers` when no Carpet backend is
    // present — still connects, its real caps (pluginState/fixtures/…) join the union,
    // and only the genuinely-absent caps' steps honestly skip. A transport failure
    // still drops the agent out entirely (its steps then skip), never a test fail.
    // When PROMOTED to the primary (the `server` driver, role "driver") it instead
    // carries the test's `required` so negotiation validates the agent grants them.
    const agentConn = (agent: AgentConn, role: "driver" | "agent"): ConnDef => ({
      url: agent.url,
      required: role === "driver" ? required : [],
      optional: advertisedKeys(agent.advertised).filter((k) => !(role === "driver" && required.includes(k))),
      advertised: agent.advertised,
      role,
      ...(role === "driver" ? withConstraints : {}),
    });

    // The cost-1 `server` driver has no endpoint of its own: the FIRST co-selected
    // server agent becomes the PRIMARY (driver) connection so a server-truth-only test
    // (e.g. `mod.loaded`, no player join — the only way to assert on a Forge/NeoForge
    // server) runs; the rest stay companions. With no agent there is nothing to drive
    // → honest skip (never a crash, never a false green).
    const serverTruthOnly = descriptor.id === "server";
    let connDefs: ConnDef[] = [];
    if (serverTruthOnly) {
      if (agents.length === 0) {
        testSkip = {
          category: "environment",
          reason: "NO_SERVER_AGENT",
          unmet: required.length ? required : ["pluginState"],
          message:
            "driver 'server' requires a co-selected server agent " +
            "(agents: [server-bukkit|server-fabric|server-forge|server-neoforge]); none was provisioned",
        };
        outcome = "skipped";
      } else {
        const [head, ...rest] = agents;
        connDefs = [agentConn(head!, "driver"), ...rest.map((a) => agentConn(a, "agent"))];
      }
    } else {
      const driverConn: ConnDef = {
        url: endpointUrl,
        required,
        optional: advertisedKeys(descriptor.advertised).filter((k) => !required.includes(k)),
        advertised: descriptor.advertised,
        role: "driver",
        ...withConstraints,
      };
      connDefs = [driverConn, ...agents.map((a) => agentConn(a, "agent"))];
    }

    try {
      try {
        if (connDefs.length) await group.connect(connDefs);
      } catch (err) {
        if (err instanceof MctpRpcError && err.code === -32002) {
          testSkip = {
            category: "capability",
            reason: "NO_COMPATIBLE_DRIVER",
            unmet: err.unmet,
            message: `session.create refused: unmet {${err.unmet.join(", ")}}`,
          };
          outcome = "skipped";
        } else {
          throw err;
        }
      }

      if (!testSkip) {
        // The union of EVERY connected surface — driver + co-selected agents —
        // is what each step's capability is matched against (not just the driver).
        const union = group.unionAdvertised();
        for (const step of test.steps) {
          const sStart = Date.now();
          const match = stepCapMatch(step.requires ?? {}, VERB_CAPABILITY[step.verb], union);
          if (!match.ok) {
            steps.push({
              index: step.index,
              verb: step.verb,
              outcome: "skipped",
              durationMs: Date.now() - sStart,
              skip: {
                category: "capability",
                reason: "NO_COMPATIBLE_DRIVER",
                unmet: match.unmet,
                message: `step '${step.verb}' requires {${match.unmet.join(", ")}} not advertised by driver '${descriptor.id}' or any co-selected agent`,
              },
            });
            continue;
          }
          const stepArtifacts: ScreenshotArtifact[] = [];
          const stepExec: ExecContext = { ...exec, serverTruthOnly, onArtifact: (a) => stepArtifacts.push(a) };
          try {
            const detail = await executeStep((cap) => group.route(cap), step, stepExec);
            steps.push({
              index: step.index,
              verb: step.verb,
              outcome: "passed",
              durationMs: Date.now() - sStart,
              detail,
              ...(stepArtifacts.length ? { artifacts: stepArtifacts.map((a) => a.path) } : {}),
              ...(stepArtifacts.find((a) => a.baseline)?.baseline
                ? { baselineDiff: stepArtifacts.find((a) => a.baseline)!.baseline }
                : {}),
            });
            for (const a of stepArtifacts) testArtifacts.push(a.path);
          } catch (err) {
            const reason = err instanceof MctpRpcError ? err.reason : undefined;
            // AUTO-CAPTURE ON FAILURE (ROADMAP §5.4): if a `screenshot`-capable
            // surface is connected, best-effort grab the screen and attach it to the
            // failure bundle. Gated on the advertised `screenshot` cap so a
            // headless/no-render driver does NO wasted round-trip; still fully
            // defensive — `tryCaptureOnFailure` never throws — so a screenshot can
            // never turn a failing step into a crash. Skipped silently otherwise.
            const failArtifacts: string[] = stepArtifacts.map((a) => a.path);
            if (exec.artifactsDir && group.unionAdvertised().screenshot === true) {
              const onFail = await tryCaptureOnFailure(group.route("screenshot"), {
                artifactsDir: exec.artifactsDir,
                slot: `failure-step${step.index}-${step.verb}`,
              });
              if (onFail) failArtifacts.push(onFail.path);
            }
            steps.push({
              index: step.index,
              verb: step.verb,
              outcome: "failed",
              durationMs: Date.now() - sStart,
              error: { message: errMessage(err), ...(reason ? { reason } : {}) },
              ...(failArtifacts.length ? { artifacts: failArtifacts } : {}),
            });
            for (const p of failArtifacts) testArtifacts.push(p);
            outcome = "failed";
            failure = {
              message: `step ${step.index} (${step.verb}) failed: ${errMessage(err)}`,
              type: reason ?? "Error",
            };
            break;
          }
        }
      }
    } catch (err) {
      outcome = "failed";
      failure = { message: errMessage(err), type: "Error" };
    } finally {
      await group.closeAll("testTeardown");
    }

    const stepsOut = renderSystemOut(steps);
    return {
      name: test.name,
      target: meta.target,
      ...(meta.loader ? { loader: meta.loader } : {}),
      ...(meta.mc ? { mc: meta.mc } : {}),
      driver: descriptor.id,
      outcome,
      durationMs: Date.now() - start,
      steps,
      ...(failure ? { failure } : {}),
      ...(testSkip ? { skip: testSkip } : {}),
      ...(brittle ? { brittle: true, notes } : {}),
      ...(testArtifacts.length ? { artifacts: testArtifacts } : {}),
      systemOut: brittle ? `${notes.join("\n")}\n${stepsOut}` : stepsOut,
    };
  }

  /**
   * Full path: select driver, provision the server, start the driver, run the
   * test, tear everything down. Provisioning is injected so the engine stays
   * decoupled from the Paper specifics (and testable without a boot).
   */
  async runTarget(
    test: NormalizedTest,
    meta: TargetMeta,
    provision: () => Promise<ProvisionHandle>,
    defaultUsername = "Tester",
    /**
     * Where reports/artifacts are written. When supplied, the `screenshot` verb
     * persists PNGs into `<outputDir>/artifacts/<target>/<name>/` and the
     * informational baseline diff reads/seeds `<outputDir>/baselines/<target>/`.
     * Absent (e.g. the M5 no-boot harness) → screenshots round-trip but aren't
     * persisted, and no baseline diff runs.
     */
    outputDir?: string,
  ): Promise<TestResult> {
    const selection = this.selectDriver(test, meta.driverPin);
    if (!selection.descriptor) {
      return {
        name: test.name,
        target: meta.target,
        ...(meta.loader ? { loader: meta.loader } : {}),
        ...(meta.mc ? { mc: meta.mc } : {}),
        outcome: "skipped",
        durationMs: 0,
        steps: [],
        skip: selection.skip,
        systemOut: selection.skip?.message,
      };
    }

    const descriptor = selection.descriptor;
    let provisioned: ProvisionHandle | undefined;
    let driver: Awaited<ReturnType<DriverDescriptor["create"]>> | undefined;
    // Assume failure until a result proves otherwise, so the cleanup hook retains
    // the instance dir on the error path too (keepOnFailure semantics).
    let failed = true;
    try {
      provisioned = await provision();
      driver = await descriptor.create(meta.launch);
      const exec: ExecContext = {
        host: provisioned.host,
        port: provisioned.port,
        defaultUsername,
        ...(outputDir ? { artifactsDir: artifactDirFor(outputDir, meta.target, test.name) } : {}),
        ...(outputDir ? { baselineDir: baselineDirFor(outputDir, meta.target) } : {}),
      };
      const result = await this.runTest(test, descriptor, driver.url, exec, meta, provisioned.agents ?? []);
      failed = result.outcome === "failed";
      // Surface the boot-log mod-load detection (F5) on the result + as a human note.
      // Informational here (any hard `MOD_NOT_LOADED` gate fires in the provisioner);
      // the MCTP `mod.loaded` assertion in the test remains authoritative.
      if (provisioned.modLoad) {
        const ml = provisioned.modLoad;
        result.modLoad = ml;
        const note = ml.missing.length
          ? `⚠ boot-log: mod(s) NOT detected loaded: ${ml.missing.join(", ")} (loader ${ml.loader}; MCTP mod.loaded is authoritative)`
          : ml.seen.length
            ? `boot-log: mod(s) detected loaded: ${ml.seen.join(", ")} (loader ${ml.loader})`
            : ml.expected.length
              ? // FML (forge/neoforge) often logs mod discovery only to debug.log, not the captured
                // console — an honest "console didn't list it" rather than a misleading empty "detected".
                `boot-log: ${ml.loader} console did not list ${ml.expected.join(", ")} (FML logs to debug.log; MCTP mod.loaded is authoritative)`
              : `boot-log: ${ml.all.length} mod(s) parsed from ${ml.loader} startup`;
        result.notes = [...(result.notes ?? []), note];
      }
      // Add the server log to the failure bundle WITHOUT clobbering any screenshot
      // artifacts the run already recorded (explicit steps + on-failure capture).
      if (provisioned.logPath && result.outcome === "failed") {
        result.artifacts = [...(result.artifacts ?? []), provisioned.logPath];
      }
      return result;
    } catch (err) {
      const msg = errMessage(err);
      // A provisioner that cannot faithfully stand up this target (e.g. no plugin-capable
      // server for an old version) signals an honest SKIP, not a failure (F2).
      if (msg.startsWith("UNSUPPORTED_TARGET:")) {
        failed = false;
        return {
          name: test.name,
          target: meta.target,
          ...(meta.loader ? { loader: meta.loader } : {}),
          ...(meta.mc ? { mc: meta.mc } : {}),
          driver: descriptor.id,
          outcome: "skipped",
          durationMs: 0,
          steps: [],
          skip: { category: "environment", reason: "UNSUPPORTED_TARGET", unmet: [], message: msg },
          systemOut: msg,
        };
      }
      return {
        name: test.name,
        target: meta.target,
        ...(meta.loader ? { loader: meta.loader } : {}),
        ...(meta.mc ? { mc: meta.mc } : {}),
        driver: descriptor.id,
        outcome: "failed",
        durationMs: 0,
        steps: [],
        failure: { message: msg, type: "ProvisionError" },
        ...(provisioned?.logPath ? { artifacts: [provisioned.logPath] } : {}),
      };
    } finally {
      if (driver) await driver.stop().catch(() => {});
      if (provisioned) {
        await provisioned.stop().catch(() => {});
        // Free the per-instance work dir on success; the provider retains it on
        // failure (keepOnFailure) so logs/artifacts survive for triage.
        await provisioned.cleanup?.(failed).catch(() => {});
      }
    }
  }
}
