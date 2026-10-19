import { APIResponseError, UnknownHTTPResponseError } from "@notionhq/client";

// How long Notion asked us to wait before trying again. It says so in two
// places: the Retry-After header, and (on 429 and 529 since 2026-09-24) the
// error body's `additional_data.retry_after`, a string of whole seconds. The
// header wins when both are present.

const RETRY_AFTER_HEADER = "retry-after";
const RETRY_AFTER_FIELD = "retry_after";
const MS_PER_SECOND = 1_000;

// Seconds, or an HTTP date, as milliseconds from now.
export function parseRetryAfter(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * MS_PER_SECOND);
  const dateMs = Date.parse(raw);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

// The SDK types `headers` as `unknown` (see fetch-types.d.ts). At runtime it's
// either a `Headers`-like object with `get` (node-fetch, native fetch) or a
// plain header-name → value record (legacy / test stubs). Handle both without
// assertions by feature-detecting.
function readRetryAfterHeader(headers: unknown): string | null {
  if (headers === null || typeof headers !== "object") return null;
  if ("get" in headers && typeof headers.get === "function") {
    const value: unknown = headers.get(RETRY_AFTER_HEADER);
    return typeof value === "string" ? value : null;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== RETRY_AFTER_HEADER) continue;
    const first = Array.isArray(value) ? value[0] : value;
    return typeof first === "string" ? first : null;
  }
  return null;
}

function readRetryAfterField(
  additionalData: Record<string, string | string[]> | undefined
): string | null {
  const value = additionalData?.[RETRY_AFTER_FIELD];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" ? first : null;
}

export function readRetryAfterMs(err: unknown): number | null {
  if (
    !APIResponseError.isAPIResponseError(err) &&
    !UnknownHTTPResponseError.isUnknownHTTPResponseError(err)
  ) {
    return null;
  }
  return (
    parseRetryAfter(readRetryAfterHeader(err.headers)) ??
    parseRetryAfter(readRetryAfterField(err.additional_data))
  );
}
