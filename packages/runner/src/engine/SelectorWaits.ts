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
}

const DEFAULT_RETRY_REASONS = ["ELEMENT_NOT_FOUND", "WORLD_NOT_READY"];

/**
 * Run `fn` repeatedly until it succeeds or its error is non-retryable / the
 * budget is exhausted. Only retries `MctpRpcError`s whose `reason` is in
 * `retryReasons` (transient by the error model's `retryable` contract).
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
      const retryable = reason !== undefined && retry.has(reason);
      const remaining = deadline - Date.now();
      if (!retryable || remaining <= 0) throw err;
      await sleep(Math.min(intervalMs, remaining));
    }
  }
}
