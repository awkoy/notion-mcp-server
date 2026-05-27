import { z } from "zod";
import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js";
import { server } from "../server/index.js";

function userMessage(text: string): GetPromptResult {
  return {
    messages: [
      {
        role: "user",
        content: { type: "text", text },
      },
    ],
  };
}

export function registerAllPrompts(): void {
  server.registerPrompt(
    "create_task",
    {
      title: "Create Notion task",
      description:
        "Create a new task page in Notion with optional status and due date.",
      argsSchema: {
        title: z.string().describe("Task title."),
        status: z
          .string()
          .optional()
          .describe("Status select value, e.g. Todo / In Progress / Done."),
        due: z
          .string()
          .optional()
          .describe("Due date as ISO 8601 (YYYY-MM-DD)."),
      },
    },
    ({ title, status, due }) => {
      const propLines = [`- title: ${JSON.stringify(title)}`];
      if (status) propLines.push(`- status: ${JSON.stringify(status)}`);
      if (due) propLines.push(`- due: ${JSON.stringify(due)}`);

      return userMessage(
        [
          `Create a new Notion task page with these fields:`,
          ...propLines,
          ``,
          `Steps:`,
          `1. If you don't already know which database holds tasks, call notion_execute with operation "search_pages" (or query_database against a known tasks DB) to locate it.`,
          `2. Call notion_execute with operation "create_page" and a payload that sets parent.database_id (or data_source_id) plus a properties object containing Title=${JSON.stringify(title)}${status ? `, Status=${JSON.stringify(status)}` : ""}${due ? `, Due=${JSON.stringify(due)}` : ""}.`,
          `3. Return the new page url to the user.`,
        ].join("\n")
      );
    }
  );

  server.registerPrompt(
    "weekly_review",
    {
      title: "Weekly review of completed work",
      description:
        "Summarize tasks marked Done in the last 7 days from a Notion database.",
      argsSchema: {},
    },
    () =>
      userMessage(
        [
          `Generate a weekly review of completed Notion tasks.`,
          ``,
          `Steps:`,
          `1. Identify the tasks database (ask the user if you don't know its id).`,
          `2. Call notion_execute with operation "query_database" using a filter for Status=Done AND Last edited time (or Created time) on_or_after the date 7 days ago. Sort by last_edited_time descending.`,
          `3. Summarize the results grouped by theme or project, with bullet points and links to each page.`,
        ].join("\n")
      )
  );

  server.registerPrompt(
    "find_pages",
    {
      title: "Find Notion pages by query",
      description: "Search Notion and show the top 5 matching pages.",
      argsSchema: {
        query: z.string().describe("Text to search for across page titles."),
      },
    },
    ({ query }) =>
      userMessage(
        [
          `Find Notion pages matching ${JSON.stringify(query)}.`,
          ``,
          `Steps:`,
          `1. Call notion_execute with operation "search_pages" and payload { "query": ${JSON.stringify(query)} }.`,
          `2. Take the top 5 results and present them as a numbered list with each page's title and url.`,
          `3. If there are no results, say so plainly.`,
        ].join("\n")
      )
  );

  server.registerPrompt(
    "daily_log",
    {
      title: "Append to daily log",
      description:
        "Append a timestamped paragraph to a daily-log page in Notion.",
      argsSchema: {
        date: z
          .string()
          .optional()
          .describe("Date for the entry as ISO 8601 (defaults to today)."),
        content: z
          .string()
          .optional()
          .describe("Text to append; prompt the user if omitted."),
      },
    },
    ({ date, content }) => {
      const pageId = process.env.NOTION_DAILY_LOG_PAGE_ID;
      const pageLine = pageId
        ? `The daily-log page id is ${pageId} (from NOTION_DAILY_LOG_PAGE_ID).`
        : `NOTION_DAILY_LOG_PAGE_ID is not set — ask the user for the daily-log page id or search for it.`;
      const dateLine = date ? `Use the date ${date}.` : `Use today's date.`;
      const contentLine = content
        ? `Append this content: ${JSON.stringify(content)}.`
        : `Ask the user what to log if the content is not yet known.`;

      return userMessage(
        [
          `Append a timestamped paragraph to the user's daily-log page.`,
          ``,
          pageLine,
          dateLine,
          contentLine,
          ``,
          `Steps:`,
          `1. Compose a paragraph block prefixed with the timestamp (date + current time).`,
          `2. Call notion_execute with operation "append_blocks" and a payload of { "block_id": "<daily-log page id>", "children": [{ "type": "paragraph", "paragraph": { "rich_text": [{ "type": "text", "text": { "content": "<timestamp> — <content>" } }] } }] }.`,
          `3. Report back the appended block's id.`,
        ].join("\n")
      );
    }
  );
}
