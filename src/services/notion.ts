import { Client } from "@notionhq/client";
import nodeFetch, { type RequestInit } from "node-fetch";
import { HttpsProxyAgent } from "https-proxy-agent";
import { authProvider } from "./auth.js";

let cachedClient: Client | null = null;
let cachedToken: string | null = null;

// Route the Notion SDK's HTTP calls through an HTTP(S) proxy when one is
// configured via the standard env vars. node-fetch is used (instead of global
// fetch) because it accepts a custom `agent`. When no proxy is set we still go
// through node-fetch so behavior is uniform.
const proxyFetch = (url: string, init?: RequestInit) => {
  const proxyURL =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    null;
  if (!proxyURL) return nodeFetch(url, init);
  return nodeFetch(url, { ...init, agent: new HttpsProxyAgent(proxyURL) });
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
