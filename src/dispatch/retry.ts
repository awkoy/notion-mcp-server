import {
  APIErrorCode,
  APIResponseError,
  RequestTimeoutError,
  UnknownHTTPResponseError,
} from "@notionhq/client";
import type { CallContext } from "../services/call-context.js";
import { isRetryableNotionCode, isRetryableWriteCode } from "../utils/error.js";
import { readRetryAfterMs } from "../utils/retry-after.js";

// Exponential-backoff retry wrapper, and the rule for which Notion requests
// may be sent again (requestRetryOpts). This is the only retry layer: the SDK
// client runs every HTTP request through it (PacedClient in
// services/notion.ts) with the SDK's own retries off, and dispatch never
// re-runs a handler. A server-provided Retry-After is waited out as given;
// otherwise the wait is full-jitter exponential backoff capped at maxMs.
// Either way the wait must fit two budgets: the request's own (budgetMs) and
// the one its dispatched call shares across all its requests (waitBudget).

export interface RetryOpts {
  attempts?: number;
  baseMs?: number;
  // Cap on the computed backoff. A server-provided Retry-After is not capped.
  maxMs?: number;
  // The longest one request may take from its first try, failed tries and
  // waits included. A wait that would end past it ends the retries and hands
  // back the error, so a long Retry-After (Notion's workspace-wide limit can
  // ask for minutes) or a run of timeouts does not hold the call open.
  budgetMs?: number;
  // Wait time left for every request of one dispatched call. Each wait is
  // taken from it, and a wait longer than what is left ends the retries, so
  // a call that sends many requests does not wait 60 s for each of them.
  waitBudget?: { remainingMs: number };
  shouldRetry?: (err: unknown) => boolean;
}

const DEFAULT_ATTEMPTS = 5;
const DEFAULT_BASE_MS = 250;
const DEFAULT_MAX_MS = 8_000;
// Notion's per-connection limit asks for at most 60 s.
const DEFAULT_BUDGET_MS = 60_000;
// The retry waits one dispatched call may add up to, across its requests.
export const CALL_WAIT_BUDGET_MS = 60_000;
const SERVER_ERROR_STATUS_MIN = 500;

// Re-export so dispatch and tests can classify codes against the same set
// without crossing modules twice.
export { isRetryableNotionCode as isRetryableErrorCode };

// Transient failures of a request that is safe to send twice: 429, 529, 5xx,
// an unknown 5xx response and a client-side timeout.
export function isRetryableSdkError(err: unknown): boolean {
  if (APIResponseError.isAPIResponseError(err)) {
    return (
      err.code === APIErrorCode.RateLimited ||
      err.status >= SERVER_ERROR_STATUS_MIN
    );
  }
  if (UnknownHTTPResponseError.isUnknownHTTPResponseError(err)) {
    return err.status >= SERVER_ERROR_STATUS_MIN;
  }
  if (RequestTimeoutError.isRequestTimeoutError(err)) {
    return true;
  }
  return false;
}

// 429 and 529 only: Notion did not run the request. A 5xx, an unknown
// response or a client-side timeout may follow a write that was applied.
export function isRetryableSdkWriteError(err: unknown): boolean {
  return APIResponseError.isAPIResponseError(err) && isRetryableWriteCode(err.code);
}

// How one Notion request is retried. Any request is retried on 429 and 529.
// A GET, or any request a read operation sends (search and data source
// queries are POSTs), is also retried on 5xx and timeouts. Any other POST,
// PATCH or DELETE is not: Notion's docs say a write "may still have been
// saved" after a 500, 503 or 504. `call` is undefined outside a dispatched
// call, e.g. for an atomic batch's rollback.
export function requestRetryOpts(
  method: string,
  call: CallContext | undefined
): RetryOpts {
  const safeToRepeat = method.toUpperCase() === "GET" || call?.access === "read";
  return {
    shouldRetry: safeToRepeat ? isRetryableSdkError : isRetryableSdkWriteError,
    waitBudget: call?.retryWait,
  };
}

function computeBackoff(
  baseMs: number,
  maxMs: number,
  attempt: number,
  retryAfterMs: number | null
): number {
  if (retryAfterMs !== null) return retryAfterMs;
  const ceiling = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.random() * ceiling;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOpts = {}
): Promise<T> {
  const attempts = opts.attempts ?? DEFAULT_ATTEMPTS;
  const baseMs = opts.baseMs ?? DEFAULT_BASE_MS;
  const maxMs = opts.maxMs ?? DEFAULT_MAX_MS;
  const deadline = Date.now() + (opts.budgetMs ?? DEFAULT_BUDGET_MS);
  const shouldRetry = opts.shouldRetry ?? isRetryableSdkError;

  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === attempts - 1 || !shouldRetry(err)) throw err;
      const wait = computeBackoff(baseMs, maxMs, attempt, readRetryAfterMs(err));
      if (Date.now() + wait > deadline) throw err;
      if (opts.waitBudget) {
        if (wait > opts.waitBudget.remainingMs) throw err;
        opts.waitBudget.remainingMs -= wait;
      }
      await sleep(wait);
    }
  }
  // Unreachable: the loop either returns or throws on the final attempt.
  throw lastErr;
}
