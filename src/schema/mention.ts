import { z } from "zod";
import { notionId } from "./id.js";

export const TEMPLATE_MENTION_USER_REQUEST_SCHEMA = z
  .object({
    type: z
      .literal("template_mention")
      .describe("Specifies this is a template mention type"),
    template_mention: z
      .object({
        type: z
          .literal("template_mention_user")
          .describe("Specifies this is a template mention user type"),
        template_mention_user: z
          .literal("me")
          .describe("Template mention user value"),
      })
      .describe("Contains the template mention user information"),
  })
  .describe("Schema for a template mention user block request");

export const TEMPLATE_MENTION_DATE_REQUEST_SCHEMA = z
  .object({
    type: z
      .literal("template_mention")
      .describe("Specifies this is a template mention type"),
    template_mention: z
      .object({
        type: z
          .literal("template_mention_date")
          .describe("Specifies this is a template mention date type"),
        template_mention_date: z
          .literal("today")
          .describe("Template mention date value"),
      })
      .describe("Contains the template mention date information"),
  })
  .describe("Schema for a template mention date block request");

export const USER_MENTION_REQUEST_SCHEMA = z
  .object({
    type: z.literal("user").describe("Specifies this is a user mention type"),
    user: z
      .object({
        id: notionId()
          .describe("The unique ID that identifies this specific user"),
        object: z
          .literal("user")
          .optional()
          .describe("Identifies this object as a user type"),
      })
      .describe("Contains the user reference information"),
  })
  .describe("Schema for a user mention block request");

export const PAGE_MENTION_REQUEST_SCHEMA = z
  .object({
    type: z.literal("page").describe("Specifies this is a page mention type"),
    page: z
      .object({
        id: notionId()
          .describe("The unique ID that identifies this specific page"),
      })
      .describe("Contains the page reference information"),
  })
  .describe("Schema for a page mention block request");

export const DATABASE_MENTION_REQUEST_SCHEMA = z
  .object({
    type: z
      .literal("database")
      .describe("Specifies this is a database mention type"),
    database: z
      .object({
        id: notionId()
          .describe("The unique ID that identifies this specific database"),
      })
      .describe("Contains the database reference information"),
  })
  .describe("Schema for a database mention block request");

export const DATE_MENTION_REQUEST_SCHEMA = z
  .object({
    type: z.literal("date").describe("Specifies this is a date mention type"),
    date: z
      .object({
        start: z.string().describe("The start date in YYYY-MM-DD format"),
        end: z
          .string()
          .nullable()
          .optional()
          .describe("The optional end date in YYYY-MM-DD format"),
      })
      .describe("Contains the date information"),
  })
  .describe("Schema for a date mention block request");

export const MENTION_REQUEST_SCHEMA = z.preprocess(
  (val) => (typeof val === "string" ? JSON.parse(val) : val),
  z
    .union([
      DATE_MENTION_REQUEST_SCHEMA,
      USER_MENTION_REQUEST_SCHEMA,
      PAGE_MENTION_REQUEST_SCHEMA,
      DATABASE_MENTION_REQUEST_SCHEMA,
      TEMPLATE_MENTION_USER_REQUEST_SCHEMA,
      TEMPLATE_MENTION_DATE_REQUEST_SCHEMA,
    ])
    .describe("Union of all possible mention request types")
);
