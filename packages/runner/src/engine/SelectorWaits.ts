/**
 * SelectorWaits — the runner-side poll/retry loop that wraps every
 * selector-bearing primitive. This is where "intelligence outside the game" is
 * most visible: the agent returns an instantaneous `ELEMENT_NOT_FOUND`; the
 * RUNNER retries until the element appears or the budget expires.
 */
import { MctpRpcError } from "../drivers/MctpClient.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface SelectorWaitOptions {
  /** Re-resolve cadence. Default 250ms. */
  intervalMs?: number;
  /** Total wall-clock budget. Default 5000ms. */
  timeoutMs?: number;
  /** Error reasons that should be retried (transient). */
  retryReasons?: string[];
  /**
   * Also retry an {@link UnsatisfiedError} — i.e. the call SUCCEEDED but the state
   * it reported does not satisfy the assertion yet. This is what turns the
   * click-retry wrapper into the `waitFor*` verbs: the same loop, the same budget,
   * the same "intelligence outside the game" — only the retry trigger widens from
   * "the element isn't there yet" to "the state isn't there yet".
   */
  retryUnsatisfied?: boolean;
}

const DEFAULT_RETRY_REASONS = ["ELEMENT_NOT_FOUND", "WORLD_NOT_READY"];

/**
 * A state that has not become true *yet*. Thrown by the `waitFor*` verbs' probe
 * and retried by the wrapper until the budget expires; its message is the same
 * mismatch description the corresponding assert-once verb would report, so a
 * timeout says exactly WHAT never became true (never a bare "timed out").
 */
export class UnsatisfiedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsatisfiedError";
  }
}

/**
 * Run `fn` repeatedly until it succeeds or its error is non-retryable / the
 * budget is exhausted. Retries `MctpRpcError`s whose `reason` is in
 * `retryReasons` (transient by the error model's `retryable` contract), and —
 * when `retryUnsatisfied` is set — `UnsatisfiedError`s too.
 *
 * On timeout the LAST error is rethrown, so the failure names the real reason the
 * wait never came true rather than a generic deadline message.
 */
export async function withSelectorWaits<T>(
  fn: () => Promise<T>,
  options: SelectorWaitOptions = {},
): Promise<T> {
  const intervalMs = options.intervalMs ?? 250;
  const timeoutMs = options.timeoutMs ?? 5000;
  const retry = new Set(options.retryReasons ?? DEFAULT_RETRY_REASONS);
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      return await fn();
    } catch (err) {
      const reason = err instanceof MctpRpcError ? err.reason : undefined;
      const retryable =
        (reason !== undefined && retry.has(reason)) ||
        (options.retryUnsatisfied === true && err instanceof UnsatisfiedError);
      const remaining = deadline - Date.now();
      if (!retryable || remaining <= 0) throw err;
      await sleep(Math.min(intervalMs, remaining));
    }
  }
}
