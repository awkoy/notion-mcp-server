import {
  APIErrorCode,
  APIResponseError,
  RequestTimeoutError,
  UnknownHTTPResponseError,
} from "@notionhq/client";
import { isRetryableNotionCode } from "../utils/error.js";

// Exponential-backoff retry wrapper for SDK calls. Retries on Notion's
// rate_limited and 5xx responses (including UnknownHTTPResponseError and
// client-side RequestTimeoutError). Respects a server-provided Retry-After
// header when present; otherwise uses full-jitter exponential backoff.

export interface RetryOpts<T> {
  attempts?: number;
  baseMs?: number;
  maxMs?: number;
  shouldRetry?: (err: unknown) => boolean;
  // Treat a resolved (non-throwing) result as a retry trigger. Used by
  // dispatch to retry handlers that wrap SDK errors into an envelope instead
  // of rethrowing.
  isRetryableResult?: (result: T) => boolean;
}

const DEFAULT_ATTEMPTS = 5;
const DEFAULT_BASE_MS = 250;
const DEFAULT_MAX_MS = 8_000;
const SERVER_ERROR_STATUS_MIN = 500;
const RETRY_AFTER_HEADER = "retry-after";
const MS_PER_SECOND = 1_000;

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

function parseRetryAfter(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * MS_PER_SECOND);
  const dateMs = Date.parse(raw);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

// The SDK types `headers` as `unknown` (see fetch-types.d.ts). At runtime it's
// either a global `Headers` instance (native fetch) or a plain
// header-name → value record (legacy / test stubs). Handle both without
// assertions by feature-detecting.
function readRetryAfterHeader(headers: unknown): string | null {
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    return headers.get(RETRY_AFTER_HEADER);
  }
  if (headers === null || typeof headers !== "object") return null;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== RETRY_AFTER_HEADER) continue;
    const first = Array.isArray(value) ? value[0] : value;
    return typeof first === "string" ? first : null;
  }
  return null;
}

function readRetryAfterMs(err: unknown): number | null {
  if (
    !APIResponseError.isAPIResponseError(err) &&
    !UnknownHTTPResponseError.isUnknownHTTPResponseError(err)
  ) {
    return null;
  }
  return parseRetryAfter(readRetryAfterHeader(err.headers));
}

function computeBackoff(
  baseMs: number,
  maxMs: number,
  attempt: number,
  retryAfterMs: number | null
): number {
  if (retryAfterMs !== null) return Math.min(retryAfterMs, maxMs);
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
  const shouldRetry = opts.shouldRetry ?? isRetryableSdkError;
  const { isRetryableResult } = opts;

  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const result = await fn();
      if (isRetryableResult && isRetryableResult(result)) {
        if (attempt === attempts - 1) return result;
        await sleep(computeBackoff(baseMs, maxMs, attempt, null));
        continue;
      }
      return result;
    } catch (err) {
      lastErr = err;
      if (attempt === attempts - 1 || !shouldRetry(err)) throw err;
      await sleep(computeBackoff(baseMs, maxMs, attempt, readRetryAfterMs(err)));
    }
  }
  // Unreachable: the loop either returns or throws on the final attempt.
  throw lastErr;
}
