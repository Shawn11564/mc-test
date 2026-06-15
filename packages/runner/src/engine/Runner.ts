/**
 * The orchestrator: select a driver by capability, open an MCTP session, run
 * the steps (with per-step honest skips and SelectorWaits), and produce a
 * `TestResult`. Driver selection flows through `DriverRegistry` +
 * `matchCapabilities` — there is no hard-coded "use headless" branch.
 */
import { PROTOCOL_VERSION, matchCapabilities } from "@mc-test/protocol";
import { MctpClient, MctpRpcError } from "../drivers/MctpClient.js";
import { DriverRegistry, type DriverDescriptor } from "../drivers/DriverRegistry.js";
import type { NormalizedTest, NormalizedStep } from "../model/Step.js";
import type { Outcome, StepResult, TestResult, SkipInfo } from "../model/result.js";
import { Session } from "./Session.js";
import { executeStep, VERB_CAPABILITY, type ExecContext } from "./StepExecutor.js";
import { advertisedKeys, capsFromKeys, requiredKeys } from "./CapabilityMatch.js";
import type { RequiredCapabilities } from "@mc-test/protocol";

/** A live, provisioned target (the server the bot will join). */
export interface ProvisionHandle {
  host: string;
  port: number;
  /** Where the server log lives (for failure artifacts). */
  logPath?: string;
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
   */
  async runTest(
    test: NormalizedTest,
    descriptor: DriverDescriptor,
    endpointUrl: string,
    exec: ExecContext,
    meta: TargetMeta,
  ): Promise<TestResult> {
    const start = Date.now();
    const steps: StepResult[] = [];
    const client = new MctpClient();
    const session = new Session(client);
    let outcome: Outcome = "passed";
    let failure: TestResult["failure"];
    let testSkip: SkipInfo | undefined;

    try {
      await client.connect(endpointUrl);
      const required = requiredKeys(test.requires);
      const optional = advertisedKeys(descriptor.advertised).filter((k) => !required.includes(k));
      try {
        await session.create({
          protocolVersion: PROTOCOL_VERSION,
          requiredCapabilities: required,
          optionalCapabilities: optional,
          constraints: {
            ...(meta.mc ? { mcVersionRange: meta.mc } : {}),
            ...(meta.loader ? { loader: meta.loader } : {}),
          },
        });
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
        for (const step of test.steps) {
          const sStart = Date.now();
          const match = matchCapabilities(stepRequired(step), descriptor.advertised);
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
                message: `step '${step.verb}' requires {${match.unmet.join(", ")}} not advertised by driver '${descriptor.id}'`,
              },
            });
            continue;
          }
          try {
            const detail = await executeStep(session, step, exec);
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
      await session.close("testTeardown");
      await client.close();
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
      const result = await this.runTest(test, descriptor, driver.url, exec, meta);
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
