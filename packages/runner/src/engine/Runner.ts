/**
 * The orchestrator: select a driver by capability, open an MCTP session, run
 * the steps (with per-step honest skips and SelectorWaits), and produce a
 * `TestResult`. Driver selection flows through `DriverRegistry` +
 * `matchCapabilities` — there is no hard-coded "use headless" branch.
 */
import { matchCapabilities, type Capabilities } from "@mc-test/protocol";
import { MctpRpcError } from "../drivers/MctpClient.js";
import { DriverRegistry, type DriverDescriptor } from "../drivers/DriverRegistry.js";
import type { NormalizedTest, NormalizedStep } from "../model/Step.js";
import type { Outcome, StepResult, TestResult, SkipInfo } from "../model/result.js";
import { SessionGroup, type ConnDef } from "./SessionGroup.js";
import { executeStep, VERB_CAPABILITY, type ExecContext } from "./StepExecutor.js";
import { advertisedKeys, requiredKeys } from "./CapabilityMatch.js";
import type { RequiredCapabilities } from "@mc-test/protocol";

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
  stop: () => Promise<void>;
}

/** Identity of the matrix cell, for reporting. */
export interface TargetMeta {
  target: string;
  loader?: string;
  mc?: string;
  /** Optional driver pin (target.driver). */
  driverPin?: string;
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

/** Capabilities a single step needs (verb-implied + its own `requires`). */
function stepRequired(step: NormalizedStep): RequiredCapabilities {
  const req: RequiredCapabilities = { ...(step.requires ?? {}) };
  const cap = VERB_CAPABILITY[step.verb];
  if (cap) req[cap] = true;
  return req;
}

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

    const required = requiredKeys(test.requires);
    const constraints = {
      ...(meta.mc ? { mcVersionRange: meta.mc } : {}),
      ...(meta.loader ? { loader: meta.loader } : {}),
    };
    const driverConn: ConnDef = {
      url: endpointUrl,
      required,
      optional: advertisedKeys(descriptor.advertised).filter((k) => !required.includes(k)),
      advertised: descriptor.advertised,
      role: "driver",
      ...(Object.keys(constraints).length ? { constraints } : {}),
    };
    // Agents negotiate only their own advertised caps; a refusing agent simply
    // drops out of the union (its steps then honestly skip) — never a test fail.
    const agentConns: ConnDef[] = agents.map((agent) => ({
      url: agent.url,
      required: advertisedKeys(agent.advertised),
      advertised: agent.advertised,
      role: "agent",
    }));

    try {
      try {
        await group.connect([driverConn, ...agentConns]);
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
          const match = matchCapabilities(stepRequired(step), union);
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
          try {
            const detail = await executeStep((cap) => group.route(cap), step, exec);
            steps.push({
              index: step.index,
              verb: step.verb,
              outcome: "passed",
              durationMs: Date.now() - sStart,
              detail,
            });
          } catch (err) {
            const reason = err instanceof MctpRpcError ? err.reason : undefined;
            steps.push({
              index: step.index,
              verb: step.verb,
              outcome: "failed",
              durationMs: Date.now() - sStart,
              error: { message: errMessage(err), ...(reason ? { reason } : {}) },
            });
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
      systemOut: renderSystemOut(steps),
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
    try {
      provisioned = await provision();
      driver = await descriptor.create();
      const exec: ExecContext = {
        host: provisioned.host,
        port: provisioned.port,
        defaultUsername,
      };
      const result = await this.runTest(test, descriptor, driver.url, exec, meta, provisioned.agents ?? []);
      if (provisioned.logPath && (result.outcome === "failed")) {
        result.artifacts = [provisioned.logPath];
      }
      return result;
    } catch (err) {
      return {
        name: test.name,
        target: meta.target,
        ...(meta.loader ? { loader: meta.loader } : {}),
        ...(meta.mc ? { mc: meta.mc } : {}),
        driver: descriptor.id,
        outcome: "failed",
        durationMs: 0,
        steps: [],
        failure: { message: errMessage(err), type: "ProvisionError" },
        ...(provisioned?.logPath ? { artifacts: [provisioned.logPath] } : {}),
      };
    } finally {
      if (driver) await driver.stop().catch(() => {});
      if (provisioned) await provisioned.stop().catch(() => {});
    }
  }
}
