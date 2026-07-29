// Default the rate limiter to a very high cap during the test suite. Tests
// that exercise the limiter itself reconfigure it explicitly via
// configureRateLimiter(); everything else runs without artificial throttling.
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { configureRateLimiter } from "../src/dispatch/rate-limit.js";

process.env.NOTION_RATE_LIMIT = process.env.NOTION_RATE_LIMIT ?? "10000";
const testLedger = join(tmpdir(), `notion-mcp-server-tests-${process.pid}.json`);
process.env.NOTION_IDEMPOTENCY_STATE_PATH ??= testLedger;
configureRateLimiter();

afterAll(() => {
  for (const suffix of ["", ".tmp", ".lock"]) {
    rmSync(`${testLedger}${suffix}`, { force: true });
  }
});
