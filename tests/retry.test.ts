import { describe, it, expect, beforeAll } from "vitest";
import { z } from "zod";
import {
  APIErrorCode,
  APIResponseError,
  ClientErrorCode,
  RequestTimeoutError,
  UnknownHTTPResponseError,
} from "@notionhq/client";
import { Headers as NodeFetchHeaders } from "node-fetch";
import {
  isRetryableErrorCode,
  isRetryableSdkError,
  isRetryableSdkWriteError,
  requestRetryOpts,
  withRetry,
} from "../src/dispatch/retry.js";
import { register } from "../src/operations/registry.js";
import type { OperationName, OperationResult } from "../src/operations/types.js";
import { dispatch } from "../src/dispatch/index.js";
import { configureOperationAccess } from "../src/operations/access.js";
import { NotionErrorCode, toErrorEnvelope } from "../src/utils/error.js";
import { parseRetryAfter, readRetryAfterMs } from "../src/utils/retry-after.js";
import { markWrite } from "../src/services/call-context.js";

const RETRY_AFTER_HEADER = "retry-after";

// The SDK does not export the constructors for APIResponseError /
// UnknownHTTPResponseError — both are package-internal. The static
// `is*Error()` typeguards key off `instanceof <Class>`, so we synthesize
// instances via Object.create + Object.assign. The single prototype-cast
// inside each helper is the unavoidable price of that; callers stay typed.

type ApiErrorInit = {
  code: APIErrorCode;
  status: number;
  headers?: unknown;
  additionalData?: Record<string, string>;
};

function makeApiError({
  code,
  status,
  headers = {},
  additionalData,
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
      additional_data: additionalData,
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

  it("waits out a Retry-After longer than maxMs: only the computed backoff is capped", async () => {
    const RETRY_AFTER_SECONDS = 0.06;
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
    }, FAST_OPTS);
    expect(result).toBe("ok");
    expect(calls).toBe(2);
    expect(Date.now() - start).toBeGreaterThanOrEqual(RETRY_AFTER_SECONDS * 1000 * 0.8);
  });

  it("gives up at once when Retry-After would run past the budget", async () => {
    let calls = 0;
    const start = Date.now();
    await expect(
      withRetry(async () => {
        calls++;
        throw makeApiError({
          code: APIErrorCode.RateLimited,
          status: 429,
          headers: { [RETRY_AFTER_HEADER]: "61" },
        });
      }, FAST_OPTS)
    ).rejects.toMatchObject({ code: APIErrorCode.RateLimited });
    expect(calls).toBe(1);
    expect(Date.now() - start).toBeLessThan(1_000);
  });

  it("stops when the next wait would pass the budget, counting the waits already made", async () => {
    // Each wait is 60 ms on a 100 ms budget: the first fits, the second
    // would end at about 120 ms, so the second error is handed back.
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw makeApiError({
          code: APIErrorCode.RateLimited,
          status: 429,
          headers: { [RETRY_AFTER_HEADER]: "0.06" },
        });
      }, { ...FAST_OPTS, budgetMs: 100 })
    ).rejects.toMatchObject({ code: APIErrorCode.RateLimited });
    expect(calls).toBe(2);
  });

  it("takes each wait from a budget shared across requests", async () => {
    // Two requests of one call: the first waits 60 ms of the 100 ms shared
    // budget, so the second cannot wait another 60 ms.
    const waitBudget = { remainingMs: 100 };
    const rateLimitedOnce = () => {
      let calls = 0;
      return async () => {
        calls++;
        if (calls === 1) {
          throw makeApiError({
            code: APIErrorCode.RateLimited,
            status: 429,
            headers: { [RETRY_AFTER_HEADER]: "0.06" },
          });
        }
        return "ok";
      };
    };
    await expect(withRetry(rateLimitedOnce(), { ...FAST_OPTS, waitBudget })).resolves.toBe("ok");
    expect(waitBudget.remainingMs).toBe(40);
    await expect(
      withRetry(rateLimitedOnce(), { ...FAST_OPTS, waitBudget })
    ).rejects.toMatchObject({ code: APIErrorCode.RateLimited });
    expect(waitBudget.remainingMs).toBe(40);
  });
});

describe("readRetryAfterMs", () => {
  it("reads the header from node-fetch's Headers, which the SDK hands back", () => {
    const headers = new NodeFetchHeaders({ "Retry-After": "2" });
    const err = makeApiError({ code: APIErrorCode.RateLimited, status: 429, headers });
    expect(readRetryAfterMs(err)).toBe(2_000);
  });

  it("falls back to additional_data.retry_after when there is no header", () => {
    const err = makeApiError({
      code: APIErrorCode.RateLimited,
      status: 429,
      additionalData: { retry_after: "7" },
    });
    expect(readRetryAfterMs(err)).toBe(7_000);
  });

  it("prefers the header when both are present", () => {
    const err = makeApiError({
      code: APIErrorCode.RateLimited,
      status: 429,
      headers: { "Retry-After": "3" },
      additionalData: { retry_after: "7" },
    });
    expect(readRetryAfterMs(err)).toBe(3_000);
  });

  it("returns null when Notion sent neither", () => {
    const err = makeApiError({ code: APIErrorCode.RateLimited, status: 429 });
    expect(readRetryAfterMs(err)).toBeNull();
    expect(readRetryAfterMs(new Error("x"))).toBeNull();
  });

  it("falls back to the body when the header is not a wait", () => {
    const err = makeApiError({
      code: APIErrorCode.RateLimited,
      status: 429,
      headers: { "Retry-After": "soon" },
      additionalData: { retry_after: "4" },
    });
    expect(readRetryAfterMs(err)).toBe(4_000);
  });
});

describe("parseRetryAfter", () => {
  it("takes seconds, whole or fractional", () => {
    expect(parseRetryAfter("2")).toBe(2_000);
    expect(parseRetryAfter("0.5")).toBe(500);
    expect(parseRetryAfter(" 3 ")).toBe(3_000);
  });

  it("takes an HTTP date", () => {
    const inFiveSeconds = new Date(Date.now() + 5_000).toUTCString();
    const ms = parseRetryAfter(inFiveSeconds);
    expect(ms).toBeGreaterThan(3_000);
    expect(ms).toBeLessThanOrEqual(5_000);
  });

  it.each(["", " ", "5, 5", "0x10", "1e3", "-1", "Infinity", "soon"])(
    "rejects %j",
    (raw) => {
      expect(parseRetryAfter(raw)).toBeNull();
    }
  );
});

describe("isRetryableSdkWriteError", () => {
  it("retries a write only on 429 and 529, where Notion did not run it", () => {
    expect(
      isRetryableSdkWriteError(makeApiError({ code: APIErrorCode.RateLimited, status: 429 }))
    ).toBe(true);
    expect(
      isRetryableSdkWriteError(makeApiError({ code: APIErrorCode.ServiceOverload, status: 529 }))
    ).toBe(true);
  });

  it("does not retry a write on 5xx, unknown responses or timeouts", () => {
    for (const [code, status] of [
      [APIErrorCode.InternalServerError, 500],
      [APIErrorCode.ServiceUnavailable, 503],
      [APIErrorCode.GatewayTimeout, 504],
    ] as const) {
      expect(isRetryableSdkWriteError(makeApiError({ code, status }))).toBe(false);
    }
    expect(isRetryableSdkWriteError(makeUnknownHttpError(502))).toBe(false);
    expect(isRetryableSdkWriteError(new RequestTimeoutError())).toBe(false);
  });
});

describe("requestRetryOpts", () => {
  const rateLimited = makeApiError({ code: APIErrorCode.RateLimited, status: 429 });
  const overloaded = makeApiError({ code: APIErrorCode.ServiceOverload, status: 529 });
  const serverError = makeApiError({ code: APIErrorCode.InternalServerError, status: 500 });
  const timeout = new RequestTimeoutError();

  function retries(method: string, access: "read" | "write" | undefined, err: unknown): boolean {
    const call = access && { access, wrote: false, retryWait: { remainingMs: 60_000 } };
    const { shouldRetry } = requestRetryOpts(method, call);
    return shouldRetry?.(err) ?? false;
  }

  it("retries a GET on 5xx and timeouts, even inside a write", () => {
    // The SDK sends methods in lower case.
    expect(retries("get", "write", serverError)).toBe(true);
    expect(retries("get", "write", timeout)).toBe(true);
    expect(retries("get", "write", makeUnknownHttpError(502))).toBe(true);
  });

  it("retries a read operation's POST (search, query) on 5xx and timeouts", () => {
    expect(retries("post", "read", serverError)).toBe(true);
    expect(retries("post", "read", timeout)).toBe(true);
  });

  it("retries a write request on 429 and 529 only", () => {
    for (const method of ["post", "patch", "delete"]) {
      expect(retries(method, "write", rateLimited)).toBe(true);
      expect(retries(method, "write", overloaded)).toBe(true);
      expect(retries(method, "write", serverError)).toBe(false);
      expect(retries(method, "write", timeout)).toBe(false);
    }
  });

  it("treats a request outside any call (a rollback) as a write", () => {
    expect(retries("patch", undefined, rateLimited)).toBe(true);
    expect(retries("patch", undefined, serverError)).toBe(false);
  });

  it("hands over the call's shared wait budget", () => {
    const retryWait = { remainingMs: 60_000 };
    const call = { access: "write" as const, wrote: false, retryWait };
    expect(requestRetryOpts("post", call).waitBudget).toBe(retryWait);
    expect(requestRetryOpts("post", undefined).waitBudget).toBeUndefined();
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

describe("dispatch — handler runs once", () => {
  // One synthetic read op and one write op, under real names (this file never
  // loads the real operations). The registry refuses a second registration,
  // so they are registered once and each test sets the step they run. The
  // SDK client retries each request on its own (tests/retry-http.test.ts), so
  // dispatch runs a handler once whatever it returns.
  const READ_OP = "get_block" as OperationName;
  const WRITE_OP = "delete_block" as OperationName;

  type Step = () => OperationResult;
  const steps = new Map<OperationName, Step>();
  let calls = 0;

  const rateLimited: Step = () => ({
    ok: false,
    error: toErrorEnvelope(makeApiError({ code: APIErrorCode.RateLimited, status: 429 })),
  });
  const wroteThen = (step: Step): Step => () => {
    markWrite();
    return step();
  };

  beforeAll(() => {
    for (const [name, access] of [
      [READ_OP, "read"],
      [WRITE_OP, "write"],
    ] as const) {
      register({
        name,
        description: "dispatch synthetic op",
        batchable: false,
        access,
        domain: "blocks",
        schema: z.object({}),
        example: {},
        handler: async () => {
          calls++;
          const step = steps.get(name);
          if (!step) throw new Error(`no step set for ${name}`);
          return step();
        },
      });
    }
    // The enabled set is cached on first use; recompute it with these ops in.
    configureOperationAccess();
  });

  function run(name: OperationName, step: Step): Promise<OperationResult> {
    calls = 0;
    steps.set(name, step);
    return dispatch(name, {}) as Promise<OperationResult>;
  }

  it("does not re-run a handler that returns a retryable envelope", async () => {
    const res = await run(READ_OP, rateLimited);
    expect(res).toMatchObject({ ok: false, error: { code: "rate_limited" } });
    expect(calls).toBe(1);
  });

  it("returns a write's error as-is when nothing was written", async () => {
    const res = await run(WRITE_OP, rateLimited);
    expect(res).toEqual(rateLimited());
  });

  it("says a write was partly applied when it fails after writing", async () => {
    const res = await run(WRITE_OP, wroteThen(rateLimited));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("rate_limited");
    expect(res.error.message).toMatch(/already applied/);
    expect(res.error.fix).toMatch(/^Read the target back/);
    expect(calls).toBe(1);
  });

  it("says so for a thrown error too", async () => {
    const res = await run(
      WRITE_OP,
      wroteThen(() => {
        throw makeApiError({ code: APIErrorCode.InternalServerError, status: 500 });
      })
    );
    expect(res).toMatchObject({
      ok: false,
      error: { code: "internal_server_error", message: expect.stringMatching(/already applied/) },
    });
  });

  it("leaves a successful write alone", async () => {
    const res = await run(WRITE_OP, wroteThen(() => ({ ok: true, data: { done: true } })));
    expect(res).toEqual({ ok: true, data: { done: true } });
  });

  it("keeps the Retry-After out of the envelope the model sees", () => {
    const envelope = toErrorEnvelope(
      makeApiError({
        code: APIErrorCode.RateLimited,
        status: 429,
        headers: { [RETRY_AFTER_HEADER]: "5" },
        additionalData: { retry_after: "5" },
      })
    );
    expect(Object.keys(envelope).sort()).toEqual(["code", "fix", "message"]);
    expect(JSON.stringify(envelope)).not.toContain("retry");
  });
});
