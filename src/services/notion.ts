import { Client } from "@notionhq/client";
import nodeFetch from "node-fetch";
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

// Route the Notion SDK's HTTP calls through an HTTP(S) proxy when one is
// configured via the standard env vars. node-fetch is used (instead of global
// fetch) because it accepts a custom `agent`. When no proxy is set we still go
// through node-fetch so behavior is uniform.
//
// @notionhq/client 5.24+ reads `response.body.getReader()` for its SSE
// streams (sessions.stream), i.e. it expects a web ReadableStream. node-fetch
// hands back a Node Readable, so we adapt the body lazily; `text()` keeps
// reading the original stream and only one of the two is ever consumed.
const proxyFetch: SupportedFetch = async (url, init) => {
  const proxyURL =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    null;
  const res = await nodeFetch(
    url,
    proxyURL ? { ...init, agent: new HttpsProxyAgent(proxyURL) } : init
  );
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
      fetch: proxyFetch,
    });
    cachedClient = fresh;
    cachedToken = token;
    return fresh;
  }
  return cachedClient;
}
