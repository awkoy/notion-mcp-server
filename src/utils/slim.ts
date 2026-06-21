import {
  isFullBlock,
  isFullComment,
  isFullDatabase,
  isFullDataSource,
  isFullPage,
  isFullUser,
} from "@notionhq/client";
import type {
  BlockObjectResponse,
  CommentObjectResponse,
  DatabaseObjectResponse,
  DataSourceObjectResponse,
  FileUploadObjectResponse,
  PageObjectResponse,
  PartialBlockObjectResponse,
  PartialCommentObjectResponse,
  PartialDatabaseObjectResponse,
  PartialDataSourceObjectResponse,
  PartialPageObjectResponse,
  PartialUserObjectResponse,
  RichTextItemResponse,
  UserObjectResponse,
} from "@notionhq/client";

export type PageResponse = PageObjectResponse | PartialPageObjectResponse;
export type BlockResponse = BlockObjectResponse | PartialBlockObjectResponse;
export type DatabaseResponse =
  | DatabaseObjectResponse
  | PartialDatabaseObjectResponse;
export type DataSourceResponse =
  | DataSourceObjectResponse
  | PartialDataSourceObjectResponse;
export type UserResponse = UserObjectResponse | PartialUserObjectResponse;
export type CommentResponse =
  | CommentObjectResponse
  | PartialCommentObjectResponse;

export type SearchItemResponse = PageResponse | DatabaseResponse | DataSourceResponse;

function extractRichText(rich: readonly RichTextItemResponse[]): string {
  return rich.map((r) => r.plain_text).join("");
}

function extractTitle(
  properties: PageObjectResponse["properties"]
): string | undefined {
  for (const value of Object.values(properties)) {
    if (value.type === "title") return extractRichText(value.title);
  }
  return undefined;
}

// Flatten a single Notion property to a primitive (or small object) the LLM
// can read directly. Returns undefined for empty values so the caller can skip
// them — keeps the response tight for sparsely populated rows.
function flattenProperty(
  prop: PageObjectResponse["properties"][string]
): unknown {
  switch (prop.type) {
    case "title":
      return extractRichText(prop.title) || undefined;
    case "rich_text":
      return extractRichText(prop.rich_text) || undefined;
    case "number":
      return prop.number ?? undefined;
    case "select":
      return prop.select?.name ?? undefined;
    case "multi_select":
      return prop.multi_select.length ? prop.multi_select.map((s) => s.name) : undefined;
    case "status":
      return prop.status?.name ?? undefined;
    case "date": {
      if (!prop.date) return undefined;
      const { start, end } = prop.date;
      return end ? { start, end } : start;
    }
    case "people":
      return prop.people.length ? prop.people.map((p) => p.id) : undefined;
    case "files":
      return prop.files.length
        ? prop.files.map((f) => {
            if (f.type === "external") return { name: f.name, url: f.external.url };
            return { name: f.name, url: f.file.url };
          })
        : undefined;
    case "checkbox":
      return prop.checkbox;
    case "url":
      return prop.url ?? undefined;
    case "email":
      return prop.email ?? undefined;
    case "phone_number":
      return prop.phone_number ?? undefined;
    case "formula": {
      const f = prop.formula;
      if (f.type === "string") return f.string ?? undefined;
      if (f.type === "number") return f.number ?? undefined;
      if (f.type === "boolean") return f.boolean ?? undefined;
      if (f.type === "date") return f.date?.start ?? undefined;
      return undefined;
    }
    case "relation":
      return prop.relation.length ? prop.relation.map((r) => r.id) : undefined;
    case "rollup": {
      const r = prop.rollup;
      if (r.type === "number") return r.number ?? undefined;
      if (r.type === "date") return r.date?.start ?? undefined;
      if (r.type === "array") {
        if (!r.array.length) return undefined;
        const flat = r.array
          .map((item) =>
            flattenProperty(item as unknown as PageObjectResponse["properties"][string])
          )
          .filter((v) => v !== undefined);
        return flat.length ? flat : undefined;
      }
      return undefined;
    }
    case "created_time":
      return prop.created_time;
    case "last_edited_time":
      return prop.last_edited_time;
    case "created_by":
      return prop.created_by.id;
    case "last_edited_by":
      return prop.last_edited_by.id;
    case "unique_id": {
      const { prefix, number } = prop.unique_id;
      if (number == null) return undefined;
      return prefix ? `${prefix}-${number}` : number;
    }
    case "verification":
      return prop.verification?.state ?? undefined;
    default:
      return undefined;
  }
}

function flattenProperties(
  properties: PageObjectResponse["properties"]
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(properties)) {
    // Skip the title prop — already surfaced as `title`.
    if (value.type === "title") continue;
    const flat = flattenProperty(value);
    if (flat !== undefined) out[name] = flat;
  }
  return out;
}

export function slimPage(
  page: PageResponse,
  verbose = false,
  includeProperties = false
) {
  if (verbose) return page;
  if (!isFullPage(page)) return { id: page.id };
  const base = {
    id: page.id,
    url: page.url,
    title: extractTitle(page.properties),
    parent: page.parent,
    ...(page.in_trash ? { in_trash: true } : {}),
    ...(page.icon ? { icon: page.icon.type } : {}),
  };
  if (!includeProperties) return base;
  const props = flattenProperties(page.properties);
  return Object.keys(props).length ? { ...base, properties: props } : base;
}

export function slimBlock(block: BlockResponse, verbose = false) {
  if (verbose) return block;
  if (!isFullBlock(block)) return { id: block.id };

  const base = {
    id: block.id,
    type: block.type,
    text: extractBlockText(block),
    ...(block.has_children ? { has_children: true } : {}),
    ...(block.in_trash ? { in_trash: true } : {}),
  };

  if (block.type === "to_do") {
    return { ...base, checked: block.to_do.checked };
  }
  if (block.type === "code") {
    return { ...base, language: block.code.language };
  }
  if (block.type === "image") {
    const img = block.image;
    const url = img.type === "external" ? img.external.url : img.file.url;
    return { ...base, image: url };
  }
  return base;
}

function extractBlockText(block: BlockObjectResponse): string | undefined {
  // Many block subtypes expose a `rich_text` array under their type key.
  // Read it via a structural narrow so we don't have to enumerate every variant.
  const inner = (block as unknown as Record<string, unknown>)[block.type];
  if (typeof inner !== "object" || inner === null) return undefined;
  const richText = (inner as { rich_text?: unknown }).rich_text;
  if (!Array.isArray(richText)) return undefined;
  return extractRichText(richText as RichTextItemResponse[]);
}

export function slimDatabase(db: DatabaseResponse, verbose = false) {
  if (verbose) return db;
  if (!isFullDatabase(db)) return { id: db.id };
  const description = extractRichText(db.description);
  return {
    id: db.id,
    url: db.url,
    title: extractRichText(db.title),
    ...(description ? { description } : {}),
    parent: db.parent,
    ...(db.in_trash ? { in_trash: true } : {}),
    ...(db.is_inline ? { is_inline: true } : {}),
    ...(db.is_locked ? { is_locked: true } : {}),
    data_sources: db.data_sources.map((s) => ({ id: s.id, name: s.name })),
    ...(db.icon ? { icon: db.icon.type } : {}),
  };
}

export function slimDataSource(ds: DataSourceResponse, verbose = false) {
  if (verbose) return ds;
  if (!isFullDataSource(ds)) return { id: ds.id };
  const description = extractRichText(ds.description);
  return {
    id: ds.id,
    url: ds.url,
    title: extractRichText(ds.title),
    ...(description ? { description } : {}),
    parent: ds.parent,
    // name → property-type map. Same byte cost as a name-only array but the
    // type info is what query_database planners actually need (otherwise
    // callers would have to drop verbose:true just to learn types).
    properties: Object.fromEntries(
      Object.entries(ds.properties).map(([name, def]) => [name, def.type])
    ),
    ...(ds.icon ? { icon: ds.icon.type } : {}),
    ...(ds.in_trash ? { in_trash: true } : {}),
  };
}

// View objects are loosely typed on the SDK surface, so accept `unknown` and
// narrow defensively. Default keeps the high-signal fields (id/name/type and
// any filter/sorts); the bulky type-specific `configuration` is verbose-only.
export function slimView(view: unknown, verbose = false) {
  if (verbose) return view;
  const v = (view ?? {}) as {
    id?: string;
    name?: string;
    type?: string;
    filter?: unknown;
    sorts?: unknown;
  };
  return {
    id: v.id,
    ...(v.name !== undefined ? { name: v.name } : {}),
    ...(v.type !== undefined ? { type: v.type } : {}),
    ...(v.filter ? { filter: v.filter } : {}),
    ...(Array.isArray(v.sorts) && v.sorts.length ? { sorts: v.sorts } : {}),
  };
}

export function slimItem(
  item: SearchItemResponse,
  verbose = false,
  includeProperties = false
) {
  if (verbose) return item;
  if (item.object === "page") return slimPage(item, verbose, includeProperties);
  if (item.object === "database") return slimDatabase(item, verbose);
  return slimDataSource(item, verbose);
}

export function slimUser(user: UserResponse, verbose = false) {
  if (verbose) return user;
  if (!isFullUser(user)) return { id: user.id };
  const base = {
    id: user.id,
    type: user.type,
    name: user.name,
    ...(user.avatar_url ? { avatar_url: user.avatar_url } : {}),
  };
  if (user.type === "person") return { ...base, email: user.person.email };
  if (user.type === "bot") {
    const workspaceName =
      "workspace_name" in user.bot ? user.bot.workspace_name : undefined;
    return workspaceName ? { ...base, workspace_name: workspaceName } : base;
  }
  return base;
}

export function slimFileUpload(fu: FileUploadObjectResponse, verbose = false) {
  if (verbose) return fu;
  return {
    file_upload_id: fu.id,
    ...(fu.status ? { status: fu.status } : {}),
    ...(fu.filename ? { filename: fu.filename } : {}),
    ...(fu.content_type ? { content_type: fu.content_type } : {}),
    ...(fu.content_length !== undefined && fu.content_length !== null
      ? { content_length: fu.content_length }
      : {}),
    ...(fu.expiry_time ? { expiry_time: fu.expiry_time } : {}),
  };
}

export function slimComment(comment: CommentResponse, verbose = false) {
  if (verbose) return comment;
  if (!isFullComment(comment)) return { id: comment.id };
  return {
    id: comment.id,
    parent: comment.parent,
    discussion_id: comment.discussion_id,
    text: extractRichText(comment.rich_text),
    created_by: comment.created_by.id,
  };
}

export function slimList<TInput, TOutput>(
  list: {
    results: TInput[];
    has_more?: boolean;
    next_cursor?: string | null;
  },
  slim: (item: TInput, verbose?: boolean) => TOutput,
  verbose = false
): { results: TOutput[]; has_more: boolean; next_cursor: string | null } {
  return {
    results: list.results.map((r) => slim(r, verbose)),
    has_more: list.has_more ?? false,
    next_cursor: list.next_cursor ?? null,
  };
}
