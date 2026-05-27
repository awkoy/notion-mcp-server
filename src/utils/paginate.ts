// Walks a Notion-style paginated endpoint until the server says has_more=false
// or we've fetched `limit` pages (whichever comes first). The cap protects
// against pathologically long walks — the caller surfaces `truncated:true` so
// the user can re-call with a higher `page_limit` or a narrower query.
//
// `limit` is in PAGES, not items: a fetch-page typically returns up to 100
// items, so the default of 10 pages caps at ~1000 items.

export interface PageResult<T> {
  results: T[];
  has_more: boolean;
  next_cursor: string | null;
}

export interface PaginateAllResult<T> {
  results: T[];
  truncated: boolean;
  pages_walked: number;
}

export const DEFAULT_PAGE_LIMIT = 10;

export async function paginateAll<T>(
  fetchPage: (cursor: string | undefined) => Promise<PageResult<T>>,
  opts: { limit?: number } = {}
): Promise<PaginateAllResult<T>> {
  const limit = opts.limit ?? DEFAULT_PAGE_LIMIT;
  const merged: T[] = [];
  let cursor: string | undefined = undefined;
  let pages_walked = 0;
  let truncated = false;

  while (true) {
    const page = await fetchPage(cursor);
    pages_walked += 1;
    merged.push(...page.results);

    if (!page.has_more) break;
    if (!page.next_cursor) {
      // Notion shouldn't return has_more=true with null next_cursor, but if it
      // does we can't continue — surface truncation so the caller can re-query
      // or report the gap rather than silently treating it as complete.
      truncated = true;
      break;
    }
    if (pages_walked >= limit) {
      truncated = true;
      break;
    }
    cursor = page.next_cursor;
  }

  return { results: merged, truncated, pages_walked };
}
