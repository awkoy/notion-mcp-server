import { z } from "zod";

const BARE_ID = /^[0-9a-f]{32}$/i;
// An id as it appears inside a URL: a 32-hex run, or a dashed uuid.
const ID_IN_URL = /[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
// `notion://` is the desktop app's deep-link scheme; same shape after the scheme.
const URL_SCHEME = /^(https?|notion):\/\//i;

/**
 * Which id a URL should yield. The Notion app puts one URL on the clipboard for
 * three different things, and the field decides which part is meant:
 *
 * - `object`: the id in the path (page, database, data source, user, …).
 * - `block`:  the `#fragment` of a block link, else the path id — a block_id
 *             field takes a page id too, so a plain page link still works.
 * - `view`:   the `?v=` of a database view link, else the path id.
 */
export type NotionIdKind = "object" | "block" | "view";

function dashed(hex: string): string {
  const s = hex.toLowerCase();
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

// A bare or dashed id, as a dashed uuid; undefined when the string is neither.
function asId(s: string): string | undefined {
  const bare = s.replace(/-/g, "");
  return BARE_ID.test(bare) ? dashed(bare) : undefined;
}

// The last id embedded in a string. A page URL is `<title-slug>-<id>`, and a
// slug or workspace segment could itself look like hex, so the last run wins.
function lastIdIn(s: string): string | undefined {
  const runs = s.match(ID_IN_URL);
  return runs ? asId(runs[runs.length - 1]) : undefined;
}

/**
 * Accept a Notion URL wherever an id belongs.
 *
 * A page URL ends with the object id, undashed, and callers paste one because
 * it is what the Notion app puts on the clipboard. The API answers
 * `invalid_request_url` for it, with no hint about what to send instead.
 *
 * Anything that is neither a 32-hex id nor a URL passes through untouched, so
 * a bad id still fails the way it did before.
 */
export function normalizeNotionId(value: string, kind?: NotionIdKind): string;
export function normalizeNotionId(value: unknown, kind?: NotionIdKind): unknown;
export function normalizeNotionId(value: unknown, kind: NotionIdKind = "object"): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();

  const direct = asId(trimmed);
  if (direct) return direct;

  if (!URL_SCHEME.test(trimmed)) return value;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return value;
  }

  if (kind === "block") {
    const anchor = lastIdIn(url.hash);
    if (anchor) return anchor;
  }
  if (kind === "view") {
    const view = asId(url.searchParams.get("v") ?? "");
    if (view) return view;
  }
  // The path holds the object id. The query is dropped on purpose: a database
  // URL carries its view id in `?v=`, and a `database_id` field means the
  // database.
  return lastIdIn(url.pathname) ?? value;
}

/**
 * A Notion object id, in place of `z.string()`.
 *
 * `z.preprocess` rather than `.transform` on purpose: a transform emits `{}`
 * as its JSON Schema, which drops the type and the description from
 * notion_describe. Chained `.describe()` and `.optional()` both survive.
 */
export function notionId(kind: NotionIdKind = "object") {
  return z.preprocess((value) => normalizeNotionId(value, kind), z.string());
}
