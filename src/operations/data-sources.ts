import { z } from "zod";
import { getClient } from "../services/notion.js";
import { register } from "./registry.js";
import { toErrorEnvelope } from "../utils/error.js";
import { DATABASE_PROPERTY_SCHEMA } from "../schema/database.js";

const VERBOSE = z.boolean().optional();

const ListDataSourcesParams = z.object({
  database_id: z.string().describe("Database ID to list data sources for."),
  verbose: VERBOSE,
});

register({
  name: "list_data_sources",
  description: "List data sources under a database. Use this before query_database when targeting multi-source databases.",
  batchable: false,
  schema: ListDataSourcesParams,
  example: { database_id: "<database-id>" },
  handler: async ({ database_id, verbose }) => {
    try {
      const notion = await getClient();
      const db = await notion.databases.retrieve({ database_id });
      const sources = (db as { data_sources?: Array<{ id: string; name?: string }> }).data_sources ?? [];
      return {
        ok: true,
        data: verbose
          ? { database_id, data_sources: sources }
          : {
              database_id,
              count: sources.length,
              data_sources: sources.map((s) => ({ id: s.id, name: s.name })),
            },
      };
    } catch (error) {
      return { ok: false, error: toErrorEnvelope(error) };
    }
  },
});

const GetDataSourceParams = z.object({
  data_source_id: z.string(),
  verbose: VERBOSE,
});

register({
  name: "get_data_source",
  description: "Retrieve a single data source's schema (its property definitions and parent database).",
  batchable: true,
  schema: GetDataSourceParams,
  example: { data_source_id: "<data-source-id>" },
  exampleBatch: { items: [{ data_source_id: "<ds-1>" }, { data_source_id: "<ds-2>" }] },
  handler: async ({ data_source_id, verbose }): Promise<{ ok: true; data: unknown } | { ok: false; error: ReturnType<typeof toErrorEnvelope> }> => {
    try {
      const notion = await getClient();
      const ds = await notion.dataSources.retrieve({ data_source_id });
      if (verbose) return { ok: true, data: ds };
      const slim = {
        id: (ds as { id: string }).id,
        parent: (ds as { parent: unknown }).parent,
        name: (ds as { name?: string }).name,
        properties: Object.keys((ds as { properties?: Record<string, unknown> }).properties ?? {}),
      };
      return { ok: true, data: slim };
    } catch (error) {
      return { ok: false, error: toErrorEnvelope(error) };
    }
  },
});

const UpdateDataSourceParams = z.object({
  data_source_id: z.string(),
  title: z.array(z.unknown()).optional().describe("Rich text array for the data source title."),
  properties: z.record(z.string(), DATABASE_PROPERTY_SCHEMA).optional(),
  icon: z.unknown().optional(),
  archived: z.boolean().optional(),
  in_trash: z.boolean().optional(),
  verbose: VERBOSE,
});

register({
  name: "update_data_source",
  description: "Update a data source's schema (properties, title, icon). For database-level metadata use update_database.",
  batchable: true,
  schema: UpdateDataSourceParams,
  example: {
    data_source_id: "<data-source-id>",
    properties: {
      Status: { type: "status", status: { options: [] } },
    },
  },
  handler: async ({ data_source_id, title, properties, icon, archived, in_trash, verbose }) => {
    try {
      const notion = await getClient();
      const response = await notion.dataSources.update({
        data_source_id,
        ...(title !== undefined ? { title: title as never } : {}),
        ...(properties !== undefined ? { properties: properties as never } : {}),
        ...(icon !== undefined ? { icon: icon as never } : {}),
        ...(archived !== undefined ? { archived } : {}),
        ...(in_trash !== undefined ? { in_trash } : {}),
      } as never);
      return { ok: true, data: verbose ? response : { id: (response as { id: string }).id } };
    } catch (error) {
      return { ok: false, error: toErrorEnvelope(error) };
    }
  },
});
