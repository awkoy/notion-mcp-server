import { isFullDatabase, isFullDataSource } from "@notionhq/client";
import type { DataSourceObjectResponse } from "@notionhq/client";
import { getClient } from "./notion.js";

/**
 * A data source's property schema, reduced to what the write and filter
 * paths need: the type of every property, plus the option names for
 * select-like properties so an error can list what is valid.
 */
export type PropertySchema = {
  type: string;
  options?: string[];
};

export type DataSourceSchema = Record<string, PropertySchema>;

// A schema changes rarely, and the cost of a stale entry is one Notion
// validation error followed by a retry after the entry expires — so a short
// TTL keeps the extra retrieve off the hot path without pinning old shapes.
const TTL_MS = 5 * 60 * 1000;

type Entry = { at: number; schema: DataSourceSchema };
const cache = new Map<string, Entry>();

/** Option names of a select / multi_select / status definition, if any. */
export function optionNames(def: { type: string; [key: string]: unknown }): string[] | undefined {
  if (def.type !== "select" && def.type !== "multi_select" && def.type !== "status") return undefined;
  const body = def[def.type] as { options?: { name: string }[] } | undefined;
  return body?.options?.map((o) => o.name);
}

export function reduceDataSourceSchema(ds: DataSourceObjectResponse): DataSourceSchema {
  const out: DataSourceSchema = {};
  for (const [name, def] of Object.entries(ds.properties)) {
    const entry: PropertySchema = { type: def.type };
    const options = optionNames(def);
    if (options) entry.options = options;
    out[name] = entry;
  }
  return out;
}

/** Property schema of a data source, fetched at most once per TTL. */
export async function getDataSourceSchema(dataSourceId: string): Promise<DataSourceSchema> {
  const hit = cache.get(dataSourceId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.schema;
  const notion = await getClient();
  const ds = await notion.dataSources.retrieve({ data_source_id: dataSourceId });
  if (!ds || !isFullDataSource(ds)) return {};
  const schema = reduceDataSourceSchema(ds);
  cache.set(dataSourceId, { at: Date.now(), schema });
  return schema;
}

/** Store a schema from a response the caller already has (an update, a retrieve). */
export function rememberDataSourceSchema(ds: DataSourceObjectResponse): void {
  cache.set(ds.id, { at: Date.now(), schema: reduceDataSourceSchema(ds) });
}

export function forgetDataSourceSchema(dataSourceId: string): void {
  cache.delete(dataSourceId);
}

export function clearSchemaCache(): void {
  cache.clear();
}

/**
 * The data source that pages under `parent` belong to, or undefined for a
 * parent that is not a database (a page, a block, the workspace).
 * A database_id parent resolves when the database has exactly one source.
 */
export async function dataSourceIdForParent(
  parent: { type: string; [key: string]: unknown } | undefined
): Promise<string | undefined> {
  if (!parent) return undefined;
  if (parent.type === "data_source_id" && typeof parent.data_source_id === "string") {
    return parent.data_source_id;
  }
  if (parent.type === "database_id" && typeof parent.database_id === "string") {
    const notion = await getClient();
    const db = await notion.databases.retrieve({ database_id: parent.database_id });
    const sources = isFullDatabase(db) ? db.data_sources : [];
    return sources.length === 1 ? sources[0].id : undefined;
  }
  return undefined;
}

/** The data source a page is a row of, or undefined when the page is not a row. */
export async function dataSourceIdForPage(pageId: string): Promise<string | undefined> {
  const notion = await getClient();
  const page = await notion.pages.retrieve({ page_id: pageId });
  const parent = (page as { parent?: { type: string; [key: string]: unknown } }).parent;
  return dataSourceIdForParent(parent);
}
