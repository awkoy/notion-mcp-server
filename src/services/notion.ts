import { Client } from "@notionhq/client";
import nodeFetch from "node-fetch";
import type { RequestInfo, RequestInit, Response } from "node-fetch";
import { HttpsProxyAgent } from "https-proxy-agent";
import { Readable } from "node:stream";
import { authProvider } from "./auth.js";

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
const sdkFetch: SupportedFetch = async (url, init) => {
  const res = await proxyAwareFetch(url, init);
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

export async function getClient(): Promise<Client> {
  const token = await authProvider.getToken();
  if (token !== cachedToken || cachedClient === null) {
    const fresh = new Client({
      auth: token,
      notionVersion: "2026-03-11",
      fetch: sdkFetch,
    });
    cachedClient = fresh;
    cachedToken = token;
    return fresh;
  }
  return cachedClient;
}
