import { z } from "zod";
import { getClient } from "../services/notion.js";
import { register } from "./registry.js";
import { tryHandler } from "../utils/handler.js";
import { slimComment, slimList } from "../utils/slim.js";
import { asSdk, type CreateCommentBody, type UpdateCommentBody } from "../utils/notion-types.js";
import { paginateAll } from "../utils/paginate.js";
import type { OperationResult } from "./types.js";

const VERBOSE = z.boolean().optional();

function plainTextRich(text: string) {
  return [{ type: "text" as const, text: { content: text } }];
}

// ──────────────────────────────────────────────────────────────────────────
// list_comments
// ──────────────────────────────────────────────────────────────────────────

const ListCommentsParams = z.object({
  block_id: z.string().describe("Page or block ID to list comments from."),
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
    .describe("Max pages to fetch when paginate=true (default 10, ~1000 comments with page_size=100)."),
  verbose: VERBOSE,
});

register({
  name: "list_comments",
  description: "List comments on a page or block. Pass paginate:true to auto-walk all pages.",
  batchable: false,
  schema: ListCommentsParams,
  example: { block_id: "<page-id>" },
  handler: tryHandler(async ({ block_id, start_cursor, page_size, paginate, page_limit, verbose }): Promise<OperationResult> => {
    const notion = await getClient();

    if (paginate) {
      const { results, truncated, pages_walked } = await paginateAll(
        async (cursor) => {
          const r = await notion.comments.list({
            block_id,
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
          results: results.map((c) => slimComment(c, verbose ?? false)),
          truncated,
          pages_walked,
        },
      };
    }

    const response = await notion.comments.list({
      block_id,
      start_cursor,
      page_size: page_size ?? 50,
    });
    return { ok: true, data: slimList(response, slimComment, verbose ?? false) };
  }),
});

// ──────────────────────────────────────────────────────────────────────────
// add_page_comment
// ──────────────────────────────────────────────────────────────────────────

const AddPageCommentParams = z
  .object({
    page_id: z.string(),
    text: z.string().optional().describe("Plain-text comment body."),
    markdown: z.string().optional().describe("Comment body as markdown. Mutually exclusive with text."),
    verbose: VERBOSE,
  })
  .refine((v) => Boolean(v.text) !== Boolean(v.markdown), {
    message: "Pass exactly one of `text` or `markdown`.",
  });

register({
  name: "add_page_comment",
  description: "Add a top-level comment to a page. Body can be plain text or markdown.",
  batchable: true,
  schema: AddPageCommentParams,
  example: { page_id: "<page-id>", text: "Looks good to me." },
  exampleBatch: {
    items: [
      { page_id: "<page-id>", text: "First note." },
      { page_id: "<page-id>", markdown: "**Second** note." },
    ],
  },
  handler: tryHandler(async ({ page_id, text, markdown, verbose }) => {
    const notion = await getClient();
    const body = markdown !== undefined
      ? { parent: { page_id }, markdown }
      : { parent: { page_id }, rich_text: plainTextRich(text!) };
    const response = await notion.comments.create(asSdk<CreateCommentBody>(body));
    return { ok: true, data: slimComment(response, verbose ?? false) };
  }),
});

// ──────────────────────────────────────────────────────────────────────────
// add_discussion_comment
// ──────────────────────────────────────────────────────────────────────────

const AddDiscussionCommentParams = z
  .object({
    discussion_id: z.string(),
    text: z.string().optional(),
    markdown: z.string().optional().describe("Comment body as markdown. Mutually exclusive with text."),
    verbose: VERBOSE,
  })
  .refine((v) => Boolean(v.text) !== Boolean(v.markdown), {
    message: "Pass exactly one of `text` or `markdown`.",
  });

register({
  name: "add_discussion_comment",
  description: "Reply to an existing discussion thread. Body can be plain text or markdown.",
  batchable: true,
  schema: AddDiscussionCommentParams,
  example: { discussion_id: "<discussion-id>", text: "Thanks for the heads-up." },
  handler: tryHandler(async ({ discussion_id, text, markdown, verbose }) => {
    const notion = await getClient();
    const body = markdown !== undefined
      ? { discussion_id, markdown }
      : { discussion_id, rich_text: plainTextRich(text!) };
    const response = await notion.comments.create(asSdk<CreateCommentBody>(body));
    return { ok: true, data: slimComment(response, verbose ?? false) };
  }),
});

// ──────────────────────────────────────────────────────────────────────────
// get_comment
// ──────────────────────────────────────────────────────────────────────────

const GetCommentParams = z.object({
  comment_id: z.string(),
  verbose: VERBOSE,
});

register({
  name: "get_comment",
  description: "Retrieve a single comment by ID.",
  batchable: true,
  schema: GetCommentParams,
  example: { comment_id: "<comment-id>" },
  handler: tryHandler(async ({ comment_id, verbose }) => {
    const notion = await getClient();
    const response = await notion.comments.retrieve({ comment_id });
    return { ok: true, data: slimComment(response, verbose ?? false) };
  }),
});

// ──────────────────────────────────────────────────────────────────────────
// update_comment
// ──────────────────────────────────────────────────────────────────────────

const UpdateCommentParams = z
  .object({
    comment_id: z.string(),
    rich_text: z.array(z.unknown()).optional(),
    markdown: z.string().optional(),
    verbose: VERBOSE,
  })
  .refine((v) => Boolean(v.rich_text) !== Boolean(v.markdown), {
    message: "Pass exactly one of `rich_text` or `markdown`.",
  });

register({
  name: "update_comment",
  description: "Replace a comment's body. Pass markdown or rich_text (not both).",
  batchable: true,
  schema: UpdateCommentParams,
  example: { comment_id: "<comment-id>", markdown: "Updated body" },
  handler: tryHandler(async ({ comment_id, rich_text, markdown, verbose }) => {
    const notion = await getClient();
    const body = markdown !== undefined
      ? { comment_id, markdown }
      : { comment_id, rich_text };
    const response = await notion.comments.update(asSdk<UpdateCommentBody>(body));
    return { ok: true, data: slimComment(response, verbose ?? false) };
  }),
});

// ──────────────────────────────────────────────────────────────────────────
// delete_comment
// ──────────────────────────────────────────────────────────────────────────

const DeleteCommentParams = z.object({
  comment_id: z.string(),
});

register({
  name: "delete_comment",
  description: "Delete a comment.",
  batchable: true,
  schema: DeleteCommentParams,
  example: { comment_id: "<comment-id>" },
  handler: tryHandler(async ({ comment_id }) => {
    const notion = await getClient();
    await notion.comments.delete({ comment_id });
    return { ok: true, data: { deleted: comment_id } };
  }),
});
