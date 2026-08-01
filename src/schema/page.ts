import { z } from "zod";
import { notionId } from "../schema/id.js";

export const PARENT_SCHEMA = z.preprocess(
  (val) => (typeof val === "string" ? JSON.parse(val) : val),
  z.union([
    z.object({
      type: z.literal("page_id").describe("Parent type for page"),
      page_id: notionId().describe("ID of the parent page"),
    }),
    z.object({
      type: z.literal("database_id").describe("Parent type for database"),
      database_id: notionId().describe("ID of the parent database"),
    }),
    z.object({
      type: z.literal("data_source_id").describe("Parent type for data source (preferred for create_page targeting a database)"),
      data_source_id: notionId().describe("ID of the parent data source"),
    }),
    z.object({
      type: z.literal("workspace").describe("Workspace-level parent (admin contexts only)"),
      workspace: z.literal(true),
    }),
    z.object({
      type: z.literal("block_id").describe("Parent type for nested block"),
      block_id: notionId(),
    }),
  ])
);
