import { z } from "zod";

const BARE_ID = /^[0-9a-f]{32}$/i;
const ID_RUN = /[0-9a-f]{32}/gi;

function dashed(hex: string): string {
  const s = hex.toLowerCase();
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
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
export function normalizeNotionId(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();

  const bare = trimmed.replace(/-/g, "");
  if (BARE_ID.test(bare)) return dashed(bare);

  if (!/^https?:\/\//i.test(trimmed)) return value;
  // Drop the query first. A database URL carries the view id in `?v=`, and the
  // path holds the id the caller means.
  const path = trimmed.split(/[?#]/)[0];
  const found = path.match(ID_RUN);
  return found ? dashed(found[found.length - 1]) : value;
}

/**
 * A Notion object id, in place of `z.string()`.
 *
 * `z.preprocess` rather than `.transform` on purpose: a transform emits `{}`
 * as its JSON Schema, which drops the type and the description from
 * notion_describe. Chained `.describe()` and `.optional()` both survive.
 */
export function notionId() {
  return z.preprocess(normalizeNotionId, z.string());
}
