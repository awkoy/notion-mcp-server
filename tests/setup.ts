// Default the rate limiter to a very high cap during the test suite. Tests
// that exercise the limiter itself reconfigure it explicitly via
// configureRateLimiter(); everything else runs without artificial throttling.
import { configureRateLimiter } from "../src/dispatch/rate-limit.js";

process.env.NOTION_RATE_LIMIT = process.env.NOTION_RATE_LIMIT ?? "10000";
configureRateLimiter();
