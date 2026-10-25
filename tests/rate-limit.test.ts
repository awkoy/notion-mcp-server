import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
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
import { configureOperationAccess } from "../src/operations/access.js";
import { getClient } from "../src/services/notion.js";

// vi.mock is hoisted above the imports, so the stub it hands out must be too.
const { fetchStub } = vi.hoisted(() => ({ fetchStub: vi.fn() }));
vi.mock("node-fetch", () => ({ default: fetchStub }));

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
  // The limiter paces Notion HTTP requests, not handler calls: the synthetic
  // op sends `n` requests through the real SDK client, and the stubbed
  // node-fetch stamps each one as it goes out.
  const OP_NAME = "list_users" as OperationName;
  const originalToken = process.env.NOTION_TOKEN;
  let calls = 0;
  const stamps: number[] = [];

  beforeAll(() => {
    process.env.NOTION_TOKEN = "ntn_rate_limit_test";
    const def: OperationDef<{ n: number }, { n: number }> = {
      name: OP_NAME,
      description: "rate-limit synthetic op",
      batchable: true,
      access: "read",
      domain: "users",
      schema: z.object({ n: z.number() }),
      example: { n: 1 },
      handler: async ({ n }) => {
        calls++;
        const notion = await getClient();
        for (let i = 0; i < n; i++) await notion.users.me({});
        return { ok: true, data: { n } };
      },
    };
    register(def);
    configureOperationAccess();
  });

  beforeEach(() => {
    calls = 0;
    fetchStub.mockReset();
    fetchStub.mockImplementation(async () => {
      stamps.push(Date.now());
      return new Response(JSON.stringify({ object: "user", id: "u1", type: "bot", bot: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    stamps.length = 0;
  });

  afterEach(() => {
    configureRateLimiter();
  });

  afterAll(() => {
    if (originalToken === undefined) delete process.env.NOTION_TOKEN;
    else process.env.NOTION_TOKEN = originalToken;
  });

  it("caps batch execution at the configured rate", async () => {
    const rate = 20;
    configureRateLimiter(rate);
    const N = 30;
    const items = Array.from({ length: N }, () => ({ n: 1 }));
    const res = await dispatch(OP_NAME, { items, concurrency: 10 });

    expect(res.ok).toBe(true);
    expect(calls).toBe(N);
    expect(stamps).toHaveLength(N);
    expect(maxInAnyWindow(stamps, ONE_SECOND_MS)).toBeLessThanOrEqual(rate + 1);
  });

  it("takes a token for every request a handler sends, not one per call", async () => {
    const rate = 20;
    configureRateLimiter(rate);
    // 8 calls of 3 requests each: one token per call would let all 24
    // requests out in about 0.4 s.
    const items = Array.from({ length: 8 }, () => ({ n: 3 }));
    const res = await dispatch(OP_NAME, { items, concurrency: 8 });

    expect(res.ok).toBe(true);
    expect(calls).toBe(8);
    expect(stamps).toHaveLength(24);
    expect(maxInAnyWindow(stamps, ONE_SECOND_MS)).toBeLessThanOrEqual(rate + 1);
  });
});
