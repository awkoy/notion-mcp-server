import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import {
  DEFAULT_RATE_PER_SECOND,
  RATE_LIMIT_ENV_VAR,
  TokenBucket,
  configureRateLimiter,
  getRateLimiterBucket,
} from "../src/dispatch/rate-limit.js";
import { register } from "../src/operations/registry.js";
import type { OperationDef, OperationName } from "../src/operations/types.js";
import { dispatch } from "../src/dispatch/index.js";

const ONE_SECOND_MS = 1_000;

function maxInAnyWindow(timestamps: number[], windowMs: number): number {
  const sorted = [...timestamps].sort((a, b) => a - b);
  let max = 0;
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j < sorted.length && sorted[j] - sorted[i] < windowMs) j++;
    max = Math.max(max, j - i);
  }
  return max;
}

describe("TokenBucket", () => {
  it("limits acquisitions to rate per sliding 1s window", async () => {
    const rate = 10;
    const bucket = new TokenBucket(rate);
    const N = 30;
    const stamps: number[] = [];

    await Promise.all(
      Array.from({ length: N }, async () => {
        await bucket.acquire();
        stamps.push(Date.now());
      })
    );

    // +1 tolerates the window-edge case: strict spacing of 1000/rate ms can
    // place exactly `rate` calls in [t, t+999ms) plus a (rate+1)th at the
    // boundary depending on scheduler jitter.
    expect(maxInAnyWindow(stamps, ONE_SECOND_MS)).toBeLessThanOrEqual(rate + 1);
    expect(stamps).toHaveLength(N);
  });

  it("rejects non-positive rates", () => {
    expect(() => new TokenBucket(0)).toThrow();
    expect(() => new TokenBucket(-1)).toThrow();
  });
});

describe("rate limiter — env configuration", () => {
  const originalEnv = process.env[RATE_LIMIT_ENV_VAR];

  afterEach(() => {
    if (originalEnv === undefined) delete process.env[RATE_LIMIT_ENV_VAR];
    else process.env[RATE_LIMIT_ENV_VAR] = originalEnv;
    configureRateLimiter();
  });

  it("NOTION_RATE_LIMIT lifts the default cap", () => {
    process.env[RATE_LIMIT_ENV_VAR] = "10";
    configureRateLimiter();
    expect(getRateLimiterBucket().rate).toBe(10);
  });

  it("falls back to the default when env var is unset", () => {
    delete process.env[RATE_LIMIT_ENV_VAR];
    configureRateLimiter();
    expect(getRateLimiterBucket().rate).toBe(DEFAULT_RATE_PER_SECOND);
  });

  it("ignores garbage env values and falls back to default", () => {
    process.env[RATE_LIMIT_ENV_VAR] = "abc";
    configureRateLimiter();
    expect(getRateLimiterBucket().rate).toBe(DEFAULT_RATE_PER_SECOND);
  });
});

describe("dispatch — rate-limiter integration", () => {
  const OP_NAME = "list_users" as OperationName;
  let counter = 0;
  const stamps: number[] = [];

  beforeEach(() => {
    counter = 0;
    stamps.length = 0;
    const def: OperationDef<{ n: number }, { n: number }> = {
      name: OP_NAME,
      description: "rate-limit synthetic op",
      batchable: true,
      schema: z.object({ n: z.number() }),
      example: { n: 0 },
      handler: async ({ n }) => {
        counter++;
        stamps.push(Date.now());
        return { ok: true, data: { n } };
      },
    };
    register(def);
  });

  afterEach(() => {
    configureRateLimiter();
  });

  it("caps batch execution at the configured rate", async () => {
    const rate = 20;
    configureRateLimiter(rate);
    const N = 30;
    const items = Array.from({ length: N }, (_, i) => ({ n: i }));
    const res = await dispatch(OP_NAME, { items, concurrency: 10 });

    expect(res.ok).toBe(true);
    expect(counter).toBe(N);
    expect(maxInAnyWindow(stamps, ONE_SECOND_MS)).toBeLessThanOrEqual(rate + 1);
  });
});
