/**
 * Short stand-ins for Notion's signed file URLs.
 *
 * A signed URL runs about 1650 characters, Notion re-signs it on every read,
 * and it expires in an hour. Emitting one costs roughly 500 tokens per file,
 * it cannot be stored, and because the signature changes per read it also
 * defeats prompt caching for any page held across turns.
 *
 * With NOTION_FILE_URLS=ref the server emits a ref instead. `get_file_url`
 * turns a ref back into a fresh signed URL, and `get_image` returns the bytes.
 * Nothing is cached: a ref names its source object, so resolving it is a read.
 */

export const FILE_REF_PREFIX = "notion-file:";

export type FileRef =
  | { kind: "block"; blockId: string }
  | { kind: "property"; pageId: string; property: string; index: number };

export function blockFileRef(blockId: string): string {
  return `${FILE_REF_PREFIX}block/${blockId}`;
}

export function propertyFileRef(
  pageId: string,
  property: string,
  index: number
): string {
  return `${FILE_REF_PREFIX}page/${pageId}/${encodeURIComponent(property)}/${index}`;
}

export function parseFileRef(ref: string): FileRef | undefined {
  if (!ref.startsWith(FILE_REF_PREFIX)) return undefined;
  const parts = ref.slice(FILE_REF_PREFIX.length).split("/");
  if (parts[0] === "block" && parts.length === 2) {
    return { kind: "block", blockId: parts[1] };
  }
  if (parts[0] === "page" && parts.length === 4) {
    const index = Number(parts[3]);
    if (!Number.isInteger(index) || index < 0) return undefined;
    return {
      kind: "property",
      pageId: parts[1],
      property: decodeURIComponent(parts[2]),
      index,
    };
  }
  return undefined;
}

/** Read the env on every call so a test can change it without a reload. */
export function fileRefsEnabled(): boolean {
  return (process.env.NOTION_FILE_URLS ?? "full").toLowerCase() === "ref";
}
