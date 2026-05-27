// Global limiter for Notion API calls. Notion enforces ~3 requests per second
// per integration; without a cap, dispatch's parallel execution (concurrency
// up to 10) hits 429s on larger batches. One shared instance means the limit
// holds across single calls, batch items, and concurrent dispatches.
//
// Implementation: a token bucket with capacity=1, equivalent to strict
// pacing — each acquire reserves the next slot at `1000 / rate` ms after the
// previous one. This guarantees the sliding-window invariant of "no more
// than `rate` calls in any 1-second window", whereas a bucket with capacity
// equal to rate would allow a 2*rate burst across the bucket-refill boundary.
//
// Rate is read from NOTION_RATE_LIMIT (requests/second). Default 3.

export const DEFAULT_RATE_PER_SECOND = 3;
export const RATE_LIMIT_ENV_VAR = "NOTION_RATE_LIMIT";
const MS_PER_SECOND = 1_000;

export class TokenBucket {
  private nextSlot = 0;
  private readonly intervalMs: number;

  constructor(public readonly rate: number) {
    if (!(rate > 0)) throw new Error(`TokenBucket rate must be > 0, got ${rate}`);
    this.intervalMs = MS_PER_SECOND / rate;
  }

  acquire(): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.nextSlot);
    this.nextSlot = slot + this.intervalMs;
    const delay = slot - now;
    if (delay <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, delay));
  }
}

function readRateFromEnv(): number {
  const raw = process.env[RATE_LIMIT_ENV_VAR];
  if (!raw) return DEFAULT_RATE_PER_SECOND;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RATE_PER_SECOND;
}

let instance = new TokenBucket(readRateFromEnv());

export const rateLimiter = {
  acquire(): Promise<void> {
    return instance.acquire();
  },
};

// Replace the singleton bucket. Used by tests and by callers that need to
// re-read NOTION_RATE_LIMIT after the env var has been mutated.
export function configureRateLimiter(rate?: number): void {
  instance = new TokenBucket(rate ?? readRateFromEnv());
}

export function getRateLimiterBucket(): TokenBucket {
  return instance;
}
