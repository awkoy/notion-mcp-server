import { z } from "zod";
import { getClient } from "../services/notion.js";
import { register } from "./registry.js";
import { tryHandler } from "../utils/handler.js";
import { slimUser, slimList } from "../utils/slim.js";
import { paginateAll } from "../utils/paginate.js";
import type { OperationResult } from "./types.js";

const VERBOSE = z.boolean().optional();

// ──────────────────────────────────────────────────────────────────────────
// list_users
// ──────────────────────────────────────────────────────────────────────────

const ListUsersParams = z.object({
  start_cursor: z.string().optional(),
  page_size: z.number().min(1).max(100).optional(),
  paginate: z
    .boolean()
    .optional()
    .describe("Auto-walk all pages and return combined results. Ignores start_cursor when set."),
  page_limit: z
    .number()
    .min(1)
    .max(1000)
    .optional()
    .describe("Max pages to fetch when paginate=true (default 10, ~1000 users with page_size=100)."),
  verbose: VERBOSE,
});

register({
  name: "list_users",
  description: "List all users in the workspace. Requires the integration to have 'Read user information' capability enabled. Pass paginate:true to auto-walk all pages.",
  batchable: false,
  schema: ListUsersParams,
  example: { page_size: 50 },
  handler: tryHandler(async ({
    start_cursor,
    page_size,
    paginate,
    page_limit,
    verbose,
  }): Promise<OperationResult> => {
    const notion = await getClient();

    if (paginate) {
      const { results, truncated, pages_walked } = await paginateAll(
        async (cursor) => {
          const r = await notion.users.list({
            start_cursor: cursor,
            page_size: page_size ?? 100,
          });
          return { results: r.results, has_more: r.has_more, next_cursor: r.next_cursor };
        },
        { limit: page_limit }
      );
      return {
        ok: true,
        data: {
          results: results.map((u) => slimUser(u, verbose ?? false)),
          truncated,
          pages_walked,
        },
      };
    }

    const response = await notion.users.list({
      start_cursor,
      page_size: page_size ?? 50,
    });
    return {
      ok: true,
      data: slimList(response, slimUser, verbose ?? false),
    };
  }),
});

// ──────────────────────────────────────────────────────────────────────────
// get_user
// ──────────────────────────────────────────────────────────────────────────

const GetUserParams = z.object({ user_id: z.string(), verbose: VERBOSE });

register({
  name: "get_user",
  description: "Get one user by ID. Requires 'Read user information' capability.",
  batchable: true,
  schema: GetUserParams,
  example: { user_id: "<user-id>" },
  handler: tryHandler(async ({ user_id, verbose }) => {
    const notion = await getClient();
    const response = await notion.users.retrieve({ user_id });
    return { ok: true, data: slimUser(response, verbose ?? false) };
  }),
});

// ──────────────────────────────────────────────────────────────────────────
// get_bot_user
// ──────────────────────────────────────────────────────────────────────────

const GetBotUserParams = z.object({ verbose: VERBOSE });

const getBotUserHandler = tryHandler(async ({ verbose }: z.infer<typeof GetBotUserParams>) => {
  const notion = await getClient();
  const response = await notion.users.me({});
  return { ok: true as const, data: slimUser(response, verbose ?? false) };
});

register({
  name: "get_bot_user",
  description: "Get the integration's bot user. Always works without extra capabilities. Alias: get_self.",
  batchable: false,
  schema: GetBotUserParams,
  example: {},
  handler: getBotUserHandler,
});

register({
  name: "get_self",
  description: "Alias of get_bot_user. Returns the integration's bot user (i.e. the identity behind the current token).",
  batchable: false,
  schema: GetBotUserParams,
  example: {},
  handler: getBotUserHandler,
});
