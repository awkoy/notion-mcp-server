import { Client } from "@notionhq/client";
import nodeFetch from "node-fetch";
import type { RequestInfo, RequestInit, Response } from "node-fetch";
import { HttpsProxyAgent } from "https-proxy-agent";
import { Readable } from "node:stream";
import { authProvider } from "./auth.js";
import { currentCall, markWrite } from "./call-context.js";
import { rateLimiter } from "../dispatch/rate-limit.js";
import { requestRetryOpts, withRetry } from "../dispatch/retry.js";

let cachedClient: Client | null = null;
let cachedToken: string | null = null;

// The fetch signature the Notion SDK accepts. Derived from the constructor
// options rather than deep-imported from build/src/fetch-types so a future
// SDK layout change surfaces here as a type error instead of a missing module.
type SupportedFetch = NonNullable<
  NonNullable<ConstructorParameters<typeof Client>[0]>["fetch"]
>;

// The proxy named by the standard env vars, or null when there is none. Read
// on every request rather than once at import so a variable set after the
// module loaded (tests, a wrapper that injects config late) is honoured.
function proxyUrl(): string | null {
  return (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    null
  );
}

// One agent per proxy URL, built the first time it is needed. An agent owns
// the connection pool, so a fresh one per request would give up keep-alive
// and open a new tunnel through the proxy for every call.
let cachedAgent: { url: string; agent: HttpsProxyAgent<string> } | null = null;

function proxyAgent(): HttpsProxyAgent<string> | undefined {
  const url = proxyUrl();
  if (!url) return undefined;
  if (cachedAgent?.url !== url) {
    cachedAgent = { url, agent: new HttpsProxyAgent(url) };
  }
  return cachedAgent.agent;
}

/**
 * node-fetch, routed through the HTTP(S) proxy named by `HTTPS_PROXY`,
 * `https_proxy`, `HTTP_PROXY` or `http_proxy` when one is set.
 *
 * Every request the server sends goes through here — the Notion SDK's API
 * calls via the adapter below, and the two direct downloads in
 * src/operations/files.ts (`upload_file`'s `url` source and `get_image`'s
 * signed URL) — so a corporate proxy sees all of them or none. node-fetch is
 * used instead of the global fetch because it accepts a custom `agent`; when
 * no proxy is set the call still goes through node-fetch so behaviour is
 * uniform. The returned `Response` is node-fetch's: `body` is a Node
 * `Readable`, not a web `ReadableStream`.
 */
export function proxyAwareFetch(
  url: URL | RequestInfo,
  init?: RequestInit
): Promise<Response> {
  const agent = proxyAgent();
  return nodeFetch(url, agent ? { ...init, agent } : init);
}

// The adapter handed to the Notion SDK.
//
// @notionhq/client 5.24+ reads `response.body.getReader()` for its SSE
// streams (sessions.stream), i.e. it expects a web ReadableStream. node-fetch
// hands back a Node Readable, so we adapt the body lazily; `text()` keeps
// reading the original stream and only one of the two is ever consumed.
//
// A 2xx answer to anything but a GET marks the call as having written, so a
// write that fails after it can say part of it was already applied.
const sdkFetch: SupportedFetch = async (url, init) => {
  const res = await proxyAwareFetch(url, init);
  if (res.ok && (init?.method ?? "GET").toUpperCase() !== "GET") markWrite();
  return {
    ok: res.ok,
    status: res.status,
    headers: res.headers,
    text: () => res.text(),
    get body() {
      return res.body ? Readable.toWeb(res.body as Readable) : null;
    },
  };
};

// The SDK client, paced by the shared rate limiter and retried one HTTP
// request at a time. Every endpoint method goes through `request`, so a
// handler that sends ten requests (batch_mixed_blocks, a multi-part upload)
// takes ten tokens, and a request that gets a 429 halfway through is sent
// again on its own, with a new token, instead of failing the whole call.
// requestRetryOpts decides which failures may be retried (a write request is
// sent again only when Notion did not run it) and how long the call's
// requests may wait in total. The limiter's wait happens here, before the SDK
// starts its request timeout, so a queued request cannot time out while it
// waits.
class PacedClient extends Client {
  override request<ResponseBody extends object>(
    args: Parameters<Client["request"]>[0]
  ): Promise<ResponseBody> {
    return withRetry(async () => {
      await rateLimiter.acquire();
      return super.request<ResponseBody>(args);
    }, requestRetryOpts(args.method, currentCall()));
  }
}

export async function getClient(): Promise<Client> {
  const token = await authProvider.getToken();
  if (token !== cachedToken || cachedClient === null) {
    const fresh = new PacedClient({
      auth: token,
      notionVersion: "2026-03-11",
      fetch: sdkFetch,
      // PacedClient.request is the one retry layer (src/dispatch/retry.ts).
      // It knows whether the request belongs to a read operation, waits out
      // Retry-After uncapped within one budget, and paces every attempt. The
      // SDK's own retries would stack under it and skip the rate limiter.
      retry: false,
    });
    cachedClient = fresh;
    cachedToken = token;
    return fresh;
  }
  return cachedClient;
}
