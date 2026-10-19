import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import type { Readable } from "node:stream";
import type { Response } from "node-fetch";
import { proxyAwareFetch, proxyUrl } from "./notion.js";
import { isPublicAddress } from "../utils/ip-range.js";
import { readCapped } from "../utils/read-capped.js";
import type { OperationError } from "../operations/types.js";

// node-fetch types the body as NodeJS.ReadableStream; at runtime it is a Node
// Readable, which is what destroy() and async iteration need.
export function bodyStream(res: Response): Readable | null {
  return res.body as Readable | null;
}

// Drop a body we will not read, so the socket goes back to the pool (or is
// closed) instead of sitting there until the response is garbage-collected.
export function discardBody(res: Response): void {
  bodyStream(res)?.destroy();
}

export type PublicFetchOptions = {
  /** Largest body accepted, in bytes. */
  maxBytes: number;
  /** One deadline for the whole fetch: every DNS lookup, hop and the body. */
  timeoutMs: number;
  /** Skip the address check (an intranet deployment that means to fetch internal hosts). */
  allowPrivate?: boolean;
  /** The error for a body over maxBytes; `size` reads "12345 bytes" or "over N bytes". */
  tooLarge: (size: string) => OperationError;
};

export type PublicFetchResult =
  | { ok: true; bytes: Buffer }
  | { ok: false; error: OperationError };

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const refused = (message: string): OperationError => ({
  code: "url_refused",
  message,
  fix: "The url source fetches public http(s) URLs only. To upload a file from a private network, read it on that network and send it as a base64 or path source.",
});

// DNS lookups take no AbortSignal, so race one against the deadline.
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      }
    );
  });
}

// Every address the host resolves to, or the reason it may not be fetched.
// All of them are checked, not just the first: the connection may use any.
async function vet(
  url: URL,
  signal: AbortSignal
): Promise<LookupAddress[] | OperationError> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const family = isIP(host);
  if (family !== 0) {
    if (!isPublicAddress(host)) {
      return refused(`Refusing to fetch ${url.href}: ${host} is a loopback, private, link-local or reserved address.`);
    }
    return [{ address: host, family }];
  }
  let addresses: LookupAddress[];
  try {
    addresses = await abortable(lookup(host, { all: true }), signal);
  } catch (err) {
    if (signal.aborted) throw err;
    const reason = (err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.message : String(err));
    return {
      code: "fetch_failed",
      message: `Could not resolve ${host} (${reason}).`,
      fix: "Check the URL. Behind a proxy, the host must still resolve from the server's machine: the server checks the address before it sends the request.",
    };
  }
  const blocked = addresses.find((a) => !isPublicAddress(a.address));
  if (blocked || addresses.length === 0) {
    return refused(
      `Refusing to fetch ${url.href}: ${host} resolves to ${blocked?.address ?? "no address"}, which is not a public address.`
    );
  }
  return addresses;
}

// An agent whose DNS answer is the one already vetted, so the connection goes
// to an address that passed the check. Resolving again at connect time would
// let a DNS server that answers differently the second time (rebinding) steer
// the request to 127.0.0.1 after the check passed.
function pinnedAgent(url: URL, addresses: LookupAddress[]): http.Agent {
  const pinned: LookupFunction = (_hostname, options, callback) => {
    const sameFamily = addresses.filter((a) => a.family === options.family);
    const pool = sameFamily.length > 0 ? sameFamily : addresses;
    // Node's happy-eyeballs connect asks for every address at once.
    if (options.all) callback(null, pool);
    else callback(null, pool[0].address, pool[0].family);
  };
  return url.protocol === "https:"
    ? new https.Agent({ lookup: pinned })
    : new http.Agent({ lookup: pinned });
}

/**
 * GET a URL the caller chose, with the guards a server needs before it does
 * that on someone's behalf:
 *
 * - http and https only, and each hop's host must resolve only to public
 *   addresses (see isPublicAddress). Redirects are followed by hand, at most
 *   five, and every Location is checked the same way, so a public URL cannot
 *   bounce the request to 169.254.169.254.
 * - With no proxy, the connection is pinned to the vetted addresses. Behind a
 *   proxy the proxy connects, so the check runs on the local DNS answer and
 *   the proxy resolves the name again; the proxy's own rules apply from there.
 * - One deadline covers DNS, every hop and the body.
 * - The body is streamed and dropped the moment it passes maxBytes.
 */
export async function fetchPublicUrl(
  raw: string,
  options: PublicFetchOptions
): Promise<PublicFetchResult> {
  const signal = AbortSignal.timeout(options.timeoutMs);
  try {
    let url = new URL(raw);
    for (let hop = 0; ; hop++) {
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return { ok: false, error: refused(`Refusing to fetch ${url.href}: only http and https URLs are fetched.`) };
      }
      let agent: http.Agent | undefined;
      if (!options.allowPrivate) {
        const vetted = await vet(url, signal);
        if ("code" in vetted) return { ok: false, error: vetted };
        if (!proxyUrl()) agent = pinnedAgent(url, vetted);
      }
      const res = await proxyAwareFetch(url.href, {
        redirect: "manual",
        signal,
        ...(agent ? { agent } : {}),
      });

      if (REDIRECT_STATUSES.has(res.status)) {
        const location = res.headers.get("location");
        discardBody(res);
        if (!location) {
          return {
            ok: false,
            error: {
              code: "fetch_failed",
              message: `${url.href} answered ${res.status} with no Location header.`,
              fix: "Pass the URL the file is actually served from.",
            },
          };
        }
        if (hop >= MAX_REDIRECTS) {
          return {
            ok: false,
            error: {
              code: "fetch_failed",
              message: `${raw} redirected more than ${MAX_REDIRECTS} times.`,
              fix: "Pass the URL the file is actually served from.",
            },
          };
        }
        url = new URL(location, url);
        continue;
      }

      if (!res.ok) {
        discardBody(res);
        return {
          ok: false,
          error: {
            code: "fetch_failed",
            message: `Failed to fetch ${url.href}: ${res.status} ${res.statusText}.`,
            fix: "Check that the URL is public and serves the file to an anonymous GET.",
          },
        };
      }
      // content-length catches most oversized responses before a byte of body
      // is read; the capped read below covers a missing or wrong header.
      const declared = Number(res.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > options.maxBytes) {
        discardBody(res);
        return { ok: false, error: options.tooLarge(`${declared} bytes`) };
      }
      const bytes = await readCapped(bodyStream(res), options.maxBytes, signal);
      if (!bytes) {
        return { ok: false, error: options.tooLarge(`over ${options.maxBytes} bytes`) };
      }
      return { ok: true, bytes };
    }
  } catch (err) {
    if (signal.aborted) {
      return {
        ok: false,
        error: {
          code: "timeout",
          message: `Fetching ${raw} took longer than ${options.timeoutMs} ms.`,
          fix: "Raise NOTION_UPLOAD_URL_TIMEOUT_MS, or download the file first and upload it as a path or base64 source.",
        },
      };
    }
    const reason = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: {
        code: "fetch_failed",
        message: `Failed to fetch ${raw}: ${reason}`,
        fix: "Check that the URL is public and reachable from the server.",
      },
    };
  }
}
