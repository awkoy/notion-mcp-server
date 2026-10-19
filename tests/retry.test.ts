import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
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
  withRetry,
} from "../src/dispatch/retry.js";
import { register } from "../src/operations/registry.js";
import type {
  OperationAccess,
  OperationDef,
  OperationName,
  OperationResult,
} from "../src/operations/types.js";
import { dispatch } from "../src/dispatch/index.js";
import { configureOperationAccess } from "../src/operations/access.js";
import { configureRateLimiter } from "../src/dispatch/rate-limit.js";
import { NotionErrorCode, toErrorEnvelope } from "../src/utils/error.js";
import { readRetryAfterMs } from "../src/utils/retry-after.js";
import { markWrite } from "../src/services/write-log.js";

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

  it("gives up at once when Retry-After is longer than maxRetryAfterMs", async () => {
    let calls = 0;
    const start = Date.now();
    await expect(
      withRetry(async () => {
        calls++;
        throw makeApiError({
          code: APIErrorCode.RateLimited,
          status: 429,
          headers: { [RETRY_AFTER_HEADER]: "120" },
        });
      }, { ...FAST_OPTS, maxRetryAfterMs: 60_000 })
    ).rejects.toMatchObject({ code: APIErrorCode.RateLimited });
    expect(calls).toBe(1);
    expect(Date.now() - start).toBeLessThan(1_000);
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
      access: "read",
      domain: "pages",
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

describe("dispatch — retry policy by access", () => {
  // One synthetic read op and one write op, under real names (this file never
  // loads the real operations). The registry refuses a second registration,
  // so they are registered once and each test sets the steps they run: each
  // call runs the next step, and the last one repeats. A step builds its
  // envelope the way a handler does, through toErrorEnvelope, so a Retry-After
  // on the SDK error travels with it.
  const READ_OP = "get_block" as OperationName;
  const WRITE_OP = "delete_block" as OperationName;

  type Step = () => OperationResult;
  type Script = { steps: Step[]; calls: number };
  const scripts = new Map<OperationName, Script>();

  function fail(init: ApiErrorInit): Step {
    return () => ({ ok: false, error: toErrorEnvelope(makeApiError(init)) });
  }
  const succeed: Step = () => ({ ok: true, data: { done: true } });

  function stubOp(name: OperationName, steps: Step[]): Script {
    const script = { steps, calls: 0 };
    scripts.set(name, script);
    return script;
  }

  beforeAll(() => {
    for (const [name, access] of [
      [READ_OP, "read"],
      [WRITE_OP, "write"],
    ] as const satisfies readonly (readonly [OperationName, OperationAccess])[]) {
      register({
        name,
        description: "retry policy synthetic op",
        batchable: false,
        access,
        domain: "blocks",
        schema: z.object({}),
        example: {},
        handler: async () => {
          const script = scripts.get(name);
          if (!script) throw new Error(`no steps set for ${name}`);
          const step = script.steps[Math.min(script.calls, script.steps.length - 1)];
          script.calls++;
          return step();
        },
      });
    }
    // The enabled set is cached on first use; recompute it with these ops in.
    configureOperationAccess();
  });

  const now0 = { [RETRY_AFTER_HEADER]: "0" };

  afterEach(() => {
    configureRateLimiter();
  });

  it("does not retry a write on 500", async () => {
    const op = stubOp(WRITE_OP, [
      fail({ code: APIErrorCode.InternalServerError, status: 500 }),
      succeed,
    ]);
    const res = await dispatch(WRITE_OP, {});
    expect(res).toMatchObject({ ok: false, error: { code: "internal_server_error" } });
    expect(op.calls).toBe(1);
  });

  it("does not retry a write on 504", async () => {
    const op = stubOp(WRITE_OP, [
      fail({ code: APIErrorCode.GatewayTimeout, status: 504 }),
      succeed,
    ]);
    const res = await dispatch(WRITE_OP, {});
    expect(res).toMatchObject({ ok: false, error: { code: "gateway_timeout" } });
    expect(op.calls).toBe(1);
  });

  it("does not retry a write on 503: Notion says it may have been saved", async () => {
    const op = stubOp(WRITE_OP, [
      fail({ code: APIErrorCode.ServiceUnavailable, status: 503 }),
      succeed,
    ]);
    await dispatch(WRITE_OP, {});
    expect(op.calls).toBe(1);
  });

  it("still retries a read on 500 and 504", async () => {
    const op = stubOp(READ_OP, [
      fail({ code: APIErrorCode.InternalServerError, status: 500, headers: now0 }),
      fail({ code: APIErrorCode.GatewayTimeout, status: 504, headers: now0 }),
      succeed,
    ]);
    const res = await dispatch(READ_OP, {});
    expect(res.ok).toBe(true);
    expect(op.calls).toBe(3);
  });

  it("retries a write on 429 and 529", async () => {
    const op = stubOp(WRITE_OP, [
      fail({ code: APIErrorCode.RateLimited, status: 429, headers: now0 }),
      fail({ code: APIErrorCode.ServiceOverload, status: 529, headers: now0 }),
      succeed,
    ]);
    const res = await dispatch(WRITE_OP, {});
    expect(res.ok).toBe(true);
    expect(op.calls).toBe(3);
  });

  it("does not re-run a write handler on 429 once it has written", async () => {
    const rateLimited = fail({ code: APIErrorCode.RateLimited, status: 429, headers: now0 });
    const op = stubOp(WRITE_OP, [
      () => {
        markWrite();
        return rateLimited();
      },
      succeed,
    ]);
    const res = await dispatch(WRITE_OP, {});
    expect(res).toMatchObject({ ok: false, error: { code: "rate_limited" } });
    expect(op.calls).toBe(1);
  });

  // The jittered backoff before the second attempt is at most 250 ms, so a
  // wait of 350 ms or more can only come from Retry-After.
  const WAIT_SECONDS = "0.4";
  const MIN_HONOURED_MS = 350;

  it("waits out the Retry-After header carried by an envelope", async () => {
    const op = stubOp(READ_OP, [
      fail({
        code: APIErrorCode.RateLimited,
        status: 429,
        headers: { [RETRY_AFTER_HEADER]: WAIT_SECONDS },
      }),
      succeed,
    ]);
    const start = Date.now();
    const res = await dispatch(READ_OP, {});
    expect(res.ok).toBe(true);
    expect(op.calls).toBe(2);
    expect(Date.now() - start).toBeGreaterThanOrEqual(MIN_HONOURED_MS);
  });

  it("waits out additional_data.retry_after carried by an envelope", async () => {
    const op = stubOp(WRITE_OP, [
      fail({
        code: APIErrorCode.RateLimited,
        status: 429,
        additionalData: { retry_after: WAIT_SECONDS },
      }),
      succeed,
    ]);
    const start = Date.now();
    const res = await dispatch(WRITE_OP, {});
    expect(res.ok).toBe(true);
    expect(op.calls).toBe(2);
    expect(Date.now() - start).toBeGreaterThanOrEqual(MIN_HONOURED_MS);
  });

  it("returns the error instead of waiting when Retry-After is over a minute", async () => {
    const op = stubOp(READ_OP, [
      fail({ code: APIErrorCode.RateLimited, status: 429, headers: { [RETRY_AFTER_HEADER]: "90" } }),
      succeed,
    ]);
    const res = await dispatch(READ_OP, {});
    expect(res).toMatchObject({ ok: false, error: { code: "rate_limited" } });
    expect(op.calls).toBe(1);
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
