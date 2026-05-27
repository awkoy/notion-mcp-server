import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import {
  APIErrorCode,
  APIResponseError,
  ClientErrorCode,
  UnknownHTTPResponseError,
} from "@notionhq/client";
import {
  isRetryableErrorCode,
  isRetryableSdkError,
  withRetry,
} from "../src/dispatch/retry.js";
import { register } from "../src/operations/registry.js";
import type { OperationDef, OperationName } from "../src/operations/types.js";
import { dispatch } from "../src/dispatch/index.js";
import { configureRateLimiter } from "../src/dispatch/rate-limit.js";
import { NotionErrorCode } from "../src/utils/error.js";

const RETRY_AFTER_HEADER = "retry-after";

// The SDK does not export the constructors for APIResponseError /
// UnknownHTTPResponseError — both are package-internal. The static
// `is*Error()` typeguards key off `instanceof <Class>`, so we synthesize
// instances via Object.create + Object.assign. The single prototype-cast
// inside each helper is the unavoidable price of that; callers stay typed.

type ApiErrorInit = {
  code: APIErrorCode;
  status: number;
  headers?: Record<string, string>;
};

function makeApiError({
  code,
  status,
  headers = {},
}: ApiErrorInit): APIResponseError {
  const err: APIResponseError = Object.assign(
    Object.create(APIResponseError.prototype) as APIResponseError,
    {
      name: "APIResponseError" as const,
      message: `API error: ${code}`,
      code,
      status,
      headers,
      body: "",
      additional_data: undefined,
      request_id: undefined,
    }
  );
  return err;
}

function makeUnknownHttpError(status: number): UnknownHTTPResponseError {
  const err: UnknownHTTPResponseError = Object.assign(
    Object.create(UnknownHTTPResponseError.prototype) as UnknownHTTPResponseError,
    {
      name: "UnknownHTTPResponseError" as const,
      message: `HTTP ${status}`,
      code: ClientErrorCode.ResponseError,
      status,
      headers: {},
      body: "",
      additional_data: undefined,
    }
  );
  return err;
}

const FAST_OPTS = { baseMs: 1, maxMs: 5, attempts: 5 } as const;

describe("withRetry — SDK errors", () => {
  it("retries APIResponseError(rate_limited) twice, then resolves", async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      if (calls <= 2) {
        throw makeApiError({ code: APIErrorCode.RateLimited, status: 429 });
      }
      return "ok";
    }, FAST_OPTS);
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("retries on 5xx (service_unavailable) once, then resolves", async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      if (calls === 1) {
        throw makeApiError({
          code: APIErrorCode.ServiceUnavailable,
          status: 503,
        });
      }
      return "ok";
    }, FAST_OPTS);
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  it("retries UnknownHTTPResponseError on 5xx", async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      if (calls === 1) throw makeUnknownHttpError(502);
      return "ok";
    }, FAST_OPTS);
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  it("does NOT retry non-retryable errors (400)", async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw makeApiError({ code: APIErrorCode.ValidationError, status: 400 });
      }, FAST_OPTS)
    ).rejects.toMatchObject({ code: APIErrorCode.ValidationError });
    expect(calls).toBe(1);
  });

  it("does NOT retry on 404 object_not_found", async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw makeApiError({ code: APIErrorCode.ObjectNotFound, status: 404 });
      }, FAST_OPTS)
    ).rejects.toMatchObject({ code: APIErrorCode.ObjectNotFound });
    expect(calls).toBe(1);
  });

  it("does NOT retry on generic non-SDK errors", async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw new Error("boom");
      }, FAST_OPTS)
    ).rejects.toThrow("boom");
    expect(calls).toBe(1);
  });

  it("gives up and rethrows after exhausting attempts", async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw makeApiError({ code: APIErrorCode.RateLimited, status: 429 });
      }, { ...FAST_OPTS, attempts: 3 })
    ).rejects.toMatchObject({ code: APIErrorCode.RateLimited });
    expect(calls).toBe(3);
  });

  it("honors Retry-After header (seconds) instead of jittered backoff", async () => {
    const RETRY_AFTER_SECONDS = 0.05;
    let calls = 0;
    const start = Date.now();
    const result = await withRetry(async () => {
      calls++;
      if (calls === 1) {
        throw makeApiError({
          code: APIErrorCode.RateLimited,
          status: 429,
          headers: { [RETRY_AFTER_HEADER]: String(RETRY_AFTER_SECONDS) },
        });
      }
      return "ok";
    }, { baseMs: 1, maxMs: 200, attempts: 5 });
    const elapsed = Date.now() - start;
    expect(result).toBe("ok");
    expect(calls).toBe(2);
    // Honored when at least ~80% of the requested wait elapsed (loose to
    // tolerate scheduler jitter).
    expect(elapsed).toBeGreaterThanOrEqual(RETRY_AFTER_SECONDS * 1000 * 0.8);
  });
});

describe("isRetryableSdkError / isRetryableErrorCode", () => {
  it("classifies rate_limited as retryable", () => {
    expect(
      isRetryableSdkError(
        makeApiError({ code: APIErrorCode.RateLimited, status: 429 })
      )
    ).toBe(true);
    expect(isRetryableErrorCode(NotionErrorCode.RateLimited)).toBe(true);
  });

  it("classifies 5xx as retryable", () => {
    expect(
      isRetryableSdkError(
        makeApiError({ code: APIErrorCode.InternalServerError, status: 500 })
      )
    ).toBe(true);
    expect(isRetryableErrorCode(NotionErrorCode.InternalServerError)).toBe(true);
  });

  it("classifies validation_error / 404 as non-retryable", () => {
    expect(
      isRetryableSdkError(
        makeApiError({ code: APIErrorCode.ValidationError, status: 400 })
      )
    ).toBe(false);
    expect(
      isRetryableSdkError(
        makeApiError({ code: APIErrorCode.ObjectNotFound, status: 404 })
      )
    ).toBe(false);
    expect(isRetryableErrorCode(NotionErrorCode.ValidationError)).toBe(false);
    expect(isRetryableErrorCode(NotionErrorCode.ObjectNotFound)).toBe(false);
  });

  it("returns false for unrelated values", () => {
    expect(isRetryableSdkError(new Error("nope"))).toBe(false);
    expect(isRetryableErrorCode(undefined)).toBe(false);
    expect(isRetryableErrorCode("totally_made_up")).toBe(false);
  });
});

describe("dispatch — handler retry on retryable envelope", () => {
  const OP_NAME = "get_bot_user" as OperationName;
  let attempts = 0;

  beforeEach(() => {
    attempts = 0;
    const def: OperationDef<{ ping: boolean }, { ping: boolean }> = {
      name: OP_NAME,
      description: "retry synthetic op",
      batchable: false,
      schema: z.object({ ping: z.boolean() }),
      example: { ping: true },
      handler: async ({ ping }) => {
        attempts++;
        if (attempts <= 2) {
          return {
            ok: false,
            error: {
              code: NotionErrorCode.RateLimited,
              message: "stub: rate limited",
            },
          };
        }
        return { ok: true, data: { ping } };
      },
    };
    register(def);
  });

  afterEach(() => {
    configureRateLimiter();
  });

  it("retries a handler that returns a retryable envelope until it succeeds", async () => {
    const res = await dispatch(OP_NAME, { ping: true });
    expect(res.ok).toBe(true);
    expect(attempts).toBe(3);
  });
});
