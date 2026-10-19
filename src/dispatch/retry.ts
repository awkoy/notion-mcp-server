import {
  APIErrorCode,
  APIResponseError,
  RequestTimeoutError,
  UnknownHTTPResponseError,
} from "@notionhq/client";
import type { OperationAccess, OperationResult } from "../operations/types.js";
import {
  envelopeRetryAfterMs,
  isRetryableNotionCode,
  isRetryableWriteCode,
} from "../utils/error.js";
import { readRetryAfterMs } from "../utils/retry-after.js";

// Exponential-backoff retry wrapper for SDK calls, and the policy dispatch
// runs every handler under (see retryPolicy). This is the only retry layer:
// the SDK client is built with `retry: false`. A server-provided Retry-After
// is waited out as given; otherwise the wait is full-jitter exponential
// backoff capped at maxMs.

export interface RetryOpts<T> {
  attempts?: number;
  baseMs?: number;
  // Cap on the computed backoff. A server-provided Retry-After is not capped.
  maxMs?: number;
  // The longest Retry-After to wait out. A longer one ends the retries and
  // hands back the error, so a call does not hang for minutes on a
  // workspace-wide limit.
  maxRetryAfterMs?: number;
  shouldRetry?: (err: unknown) => boolean;
  // Treat a resolved (non-throwing) result as a retry trigger. Used by
  // dispatch to retry handlers that wrap SDK errors into an envelope instead
  // of rethrowing.
  isRetryableResult?: (result: T) => boolean;
  // The Retry-After a retryable result carries, if any.
  resultRetryAfterMs?: (result: T) => number | null;
}

const DEFAULT_ATTEMPTS = 5;
const DEFAULT_BASE_MS = 250;
const DEFAULT_MAX_MS = 8_000;
// Notion's per-connection limit asks for at most 60 s.
const DEFAULT_MAX_RETRY_AFTER_MS = 60_000;
const SERVER_ERROR_STATUS_MIN = 500;

// Re-export so dispatch and tests can classify codes against the same set
// without crossing modules twice.
export { isRetryableNotionCode as isRetryableErrorCode };

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

// The policy for one dispatched handler call.
//
// A read has no side effects, so every transient failure is retried: 429,
// 529, 5xx and client-side timeouts.
//
// A write is retried only on 429 and 529, and only while nothing in the call
// has been written yet (`writes.wrote`, see services/write-log.ts). Once one
// request has landed, running the handler again would repeat it.
export function retryPolicy(
  access: OperationAccess,
  writes: { readonly wrote: boolean }
): RetryOpts<OperationResult> {
  const resultRetryAfterMs = (r: OperationResult) =>
    r.ok ? null : envelopeRetryAfterMs(r.error);
  if (access === "read") {
    return {
      isRetryableResult: (r) => !r.ok && isRetryableNotionCode(r.error.code),
      resultRetryAfterMs,
    };
  }
  return {
    shouldRetry: (err) => !writes.wrote && isRetryableSdkWriteError(err),
    isRetryableResult: (r) =>
      !writes.wrote && !r.ok && isRetryableWriteCode(r.error.code),
    resultRetryAfterMs,
  };
}

// The wait before the next attempt, or null to stop retrying.
function computeBackoff(
  baseMs: number,
  maxMs: number,
  maxRetryAfterMs: number,
  attempt: number,
  retryAfterMs: number | null
): number | null {
  if (retryAfterMs !== null) {
    return retryAfterMs <= maxRetryAfterMs ? retryAfterMs : null;
  }
  const ceiling = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.random() * ceiling;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOpts<T> = {}
): Promise<T> {
  const attempts = opts.attempts ?? DEFAULT_ATTEMPTS;
  const baseMs = opts.baseMs ?? DEFAULT_BASE_MS;
  const maxMs = opts.maxMs ?? DEFAULT_MAX_MS;
  const maxRetryAfterMs = opts.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS;
  const shouldRetry = opts.shouldRetry ?? isRetryableSdkError;
  const { isRetryableResult, resultRetryAfterMs } = opts;

  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const result = await fn();
      if (isRetryableResult && isRetryableResult(result)) {
        if (attempt === attempts - 1) return result;
        const retryAfterMs = resultRetryAfterMs ? resultRetryAfterMs(result) : null;
        const wait = computeBackoff(baseMs, maxMs, maxRetryAfterMs, attempt, retryAfterMs);
        if (wait === null) return result;
        await sleep(wait);
        continue;
      }
      return result;
    } catch (err) {
      lastErr = err;
      if (attempt === attempts - 1 || !shouldRetry(err)) throw err;
      const wait = computeBackoff(baseMs, maxMs, maxRetryAfterMs, attempt, readRetryAfterMs(err));
      if (wait === null) throw err;
      await sleep(wait);
    }
  }
  // Unreachable: the loop either returns or throws on the final attempt.
  throw lastErr;
}
