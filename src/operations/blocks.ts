import { z } from "zod";
import { getClient } from "../services/notion.js";
import { register } from "./registry.js";
import { tryHandler } from "../utils/handler.js";
import { slimBlock, slimList } from "../utils/slim.js";
import { parseMarkdownToBlocks } from "../markdown/parse.js";
import { TEXT_BLOCK_REQUEST_SCHEMA } from "../schema/blocks.js";
import type { OperationResult } from "./types.js";
import {
  asSdk,
  type AppendBlockBody,
  type AppendBlockChildren,
  type UpdateBlockBody,
} from "../utils/notion-types.js";

const VERBOSE = z.boolean().optional();

// ──────────────────────────────────────────────────────────────────────────
// append_blocks
// ──────────────────────────────────────────────────────────────────────────

const AppendBlocksParams = z
  .object({
    block_id: z.string().describe("Parent page ID or block ID to append into."),
    markdown: z.string().optional().describe("Content to append, as markdown. Parsed server-side."),
    children: z.array(z.unknown()).optional().describe("Structured Notion blocks. Mutually exclusive with markdown."),
    after: z.string().optional().describe("Append immediately after this block ID (legacy ordering)."),
    position: z.enum(["start", "end"]).optional().describe("Append at start or end. Preferred over `after`."),
    verbose: VERBOSE,
  })
  .refine((v) => Boolean(v.markdown) !== Boolean(v.children), {
    message: "Pass exactly one of `markdown` or `children`.",
  })
  .refine((v) => !(v.after && v.position), {
    message: "Pass at most one of `after` or `position`.",
  });

register({
  name: "append_blocks",
  access: "write",
  domain: "blocks",
  description: "Append children to a page or block. Use markdown for prose content.",
  batchable: true,
  schema: AppendBlocksParams,
  example: {
    block_id: "<page-or-block-id>",
    markdown: "## Section\n\n- bullet 1\n- bullet 2",
  },
  exampleBatch: {
    items: [
      { block_id: "<page-id-1>", markdown: "Body 1" },
      { block_id: "<page-id-2>", markdown: "Body 2" },
    ],
  },
  handler: tryHandler(async ({ block_id, markdown, children, after, position, verbose }): Promise<OperationResult> => {
    const blocks = markdown ? parseMarkdownToBlocks(markdown) : (children ?? []);
    if (blocks.length === 0) {
      return {
        ok: false,
        error: {
          code: "empty_content",
          message: "No blocks to append (markdown parsed to empty, or children array is empty).",
        },
      };
    }
    const positionArg = position
      ? { type: position }
      : after
        ? { type: "after_block" as const, after_block: { id: after } }
        : undefined;
    const notion = await getClient();
    const body = {
      block_id,
      children: asSdk<AppendBlockChildren>(blocks),
      ...(positionArg ? { position: positionArg } : {}),
    };
    const response = await notion.blocks.children.append(asSdk<AppendBlockBody>(body));
    // Notion returns just the new blocks for default/end/after positions, but
    // the full updated child set for `position: "start"` (new blocks appear
    // first). Slice to the requested count so the response stays bounded.
    // If the response is shorter than expected (shouldn't happen, but be safe),
    // surface only what we got and skip ID emission rather than return wrong IDs.
    const canMapIds = response.results.length >= blocks.length;
    const newBlocks = canMapIds
      ? response.results.slice(0, blocks.length)
      : response.results;
    if (verbose) {
      return {
        ok: true,
        data: {
          appended: blocks.length,
          results: newBlocks.map((r) => slimBlock(r, true)),
        },
      };
    }
    return {
      ok: true,
      data: {
        appended: blocks.length,
        ...(canMapIds ? { ids: newBlocks.map((r) => r.id) } : {}),
      },
    };
  }),
});

// ──────────────────────────────────────────────────────────────────────────
// get_block
// ──────────────────────────────────────────────────────────────────────────

const GetBlockParams = z.object({
  block_id: z.string().describe("Block ID to retrieve."),
  verbose: VERBOSE,
});

register({
  name: "get_block",
  access: "read",
  domain: "blocks",
  description: "Retrieve a single block by ID (metadata + type-specific body). For its children, use get_block_children.",
  batchable: true,
  schema: GetBlockParams,
  example: { block_id: "<block-id>" },
  exampleBatch: {
    items: [{ block_id: "<block-id-1>" }, { block_id: "<block-id-2>" }],
  },
  handler: tryHandler(async ({ block_id, verbose }) => {
    const notion = await getClient();
    const response = await notion.blocks.retrieve({ block_id });
    return { ok: true, data: slimBlock(response, verbose ?? false) };
  }),
});

// ──────────────────────────────────────────────────────────────────────────
// get_block_children
// ──────────────────────────────────────────────────────────────────────────

const GetBlockChildrenParams = z.object({
  block_id: z.string().describe("Page ID or block ID. For a page, returns its top-level blocks."),
  start_cursor: z.string().optional(),
  page_size: z.number().min(1).max(100).optional(),
  verbose: VERBOSE,
});

register({
  name: "get_block_children",
  access: "read",
  domain: "blocks",
  description: "List child blocks under a page or block, paginated.",
  batchable: false,
  schema: GetBlockChildrenParams,
  example: { block_id: "<page-id>", page_size: 100 },
  handler: tryHandler(async ({ block_id, start_cursor, page_size, verbose }) => {
    const notion = await getClient();
    const response = await notion.blocks.children.list({
      block_id,
      start_cursor,
      page_size: page_size ?? 100,
    });
    return { ok: true, data: slimList(response, slimBlock, verbose ?? false) };
  }),
});

// ──────────────────────────────────────────────────────────────────────────
// update_block
// ──────────────────────────────────────────────────────────────────────────

type BlockTypedBody = { type: string; [key: string]: unknown };

function extractTypedBody(block: BlockTypedBody): Record<string, unknown> {
  return { [block.type]: block[block.type] };
}

// Block-type keys recognized in update_block's structured `data`.
// When `data` has exactly one of these keys and no explicit `type`,
// we infer the discriminator so the caller can write {to_do:{...}}
// instead of {type:"to_do", to_do:{...}}.
const INFERRABLE_BLOCK_TYPES = new Set([
  "paragraph",
  "heading_1",
  "heading_2",
  "heading_3",
  "heading_4",
  "quote",
  "callout",
  "toggle",
  "bulleted_list_item",
  "numbered_list_item",
  "to_do",
  "code",
  "divider",
  "image",
  "tab",
]);

function inferDataType(input: unknown): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
  const obj = input as Record<string, unknown>;
  if (typeof obj.type === "string") return obj;
  const matched = Object.keys(obj).filter((k) => INFERRABLE_BLOCK_TYPES.has(k));
  if (matched.length === 1) {
    return { type: matched[0], ...obj };
  }
  return obj;
}

const UpdateBlockParams = z
  .object({
    block_id: z.string(),
    markdown: z
      .string()
      .optional()
      .describe("New content as markdown. Must parse to exactly one block matching the existing block's type."),
    data: z
      .preprocess(inferDataType, TEXT_BLOCK_REQUEST_SCHEMA)
      .optional()
      .describe(
        "Structured block envelope: `{type, <type>: {...}}` (e.g. `{type:\"to_do\", to_do:{rich_text:[...], checked:true}}`). When `type` is omitted, it is inferred from the sole block-type key, so `{to_do:{...}}` works as well. Type must match the existing block."
      ),
    verbose: VERBOSE,
  })
  .refine((v) => Boolean(v.markdown) !== Boolean(v.data), {
    message: "Pass exactly one of `markdown` or `data`.",
  });

register({
  name: "update_block",
  access: "write",
  domain: "blocks",
  description:
    "Update an existing block's content. Pass `markdown` for prose blocks (parsed locally to a single block), or `data` for structured updates such as toggling a to_do's `checked` field or setting a code block's language.",
  batchable: true,
  schema: UpdateBlockParams,
  example: { block_id: "<block-id>", markdown: "Updated paragraph text." },
  exampleBatch: {
    items: [
      { block_id: "<block-id-1>", markdown: "First update." },
      {
        block_id: "<block-id-2>",
        data: { to_do: { rich_text: [{ type: "text", text: { content: "Done" } }], checked: true } },
      },
    ],
  },
  handler: tryHandler(async ({ block_id, markdown, data, verbose }) => {
    let body: Record<string, unknown>;
    if (markdown) {
      const parsed = parseMarkdownToBlocks(markdown);
      if (parsed.length !== 1) {
        return {
          ok: false,
          error: {
            code: "markdown_multiblock",
            message: `Update requires exactly one block; markdown parsed to ${parsed.length}.`,
            fix: "Use append_blocks for multi-block content, or shorten markdown to a single block.",
          },
        };
      }
      body = extractTypedBody(parsed[0] as BlockTypedBody);
    } else {
      body = extractTypedBody(data as BlockTypedBody);
    }
    const notion = await getClient();
    const response = await notion.blocks.update(
      asSdk<UpdateBlockBody>({ block_id, ...body })
    );
    return { ok: true, data: slimBlock(response, verbose ?? false) };
  }),
});

// ──────────────────────────────────────────────────────────────────────────
// delete_block
// ──────────────────────────────────────────────────────────────────────────

const DeleteBlockParams = z.object({ block_id: z.string(), verbose: VERBOSE });

register({
  name: "delete_block",
  access: "write",
  domain: "blocks",
  destructive: true,
  description: "Archive (soft-delete) a block.",
  batchable: true,
  schema: DeleteBlockParams,
  example: { block_id: "<block-id>" },
  exampleBatch: { items: [{ block_id: "<block-id-1>" }, { block_id: "<block-id-2>" }] },
  handler: tryHandler(async ({ block_id, verbose }) => {
    const notion = await getClient();
    const response = await notion.blocks.delete({ block_id });
    return { ok: true, data: slimBlock(response, verbose ?? false) };
  }),
});

// ──────────────────────────────────────────────────────────────────────────
// batch_mixed_blocks  (power-user escape hatch for atomic-ish mixed ops)
// ──────────────────────────────────────────────────────────────────────────

const MixedOp = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("append"),
    block_id: z.string(),
    markdown: z.string().optional(),
    children: z.array(z.unknown()).optional(),
  }),
  z.object({
    op: z.literal("update"),
    block_id: z.string(),
    markdown: z.string().optional(),
    data: z.preprocess(inferDataType, TEXT_BLOCK_REQUEST_SCHEMA).optional(),
  }),
  z.object({
    op: z.literal("delete"),
    block_id: z.string(),
  }),
]);

const BatchMixedBlocksParams = z.object({
  operations: z.array(MixedOp).min(1),
  verbose: VERBOSE,
});

register({
  name: "batch_mixed_blocks",
  access: "write",
  domain: "blocks",
  destructive: true,
  description:
    "Run a sequence of mixed block operations (append/update/delete) in order. Uses a non-standard envelope: { operations: [{ op: \"append\"|\"update\"|\"delete\", ... }] } — NOT the universal { items: [...] } batch envelope. For pure single-op batches, prefer the items[] form on append_blocks / update_block / delete_block.",
  batchable: false,
  schema: BatchMixedBlocksParams,
  example: {
    operations: [
      { op: "append", block_id: "<page-id>", markdown: "Header\n" },
      { op: "update", block_id: "<block-id>", markdown: "New text" },
      { op: "delete", block_id: "<other-block-id>" },
    ],
  },
  handler: tryHandler(async ({ operations, verbose }) => {
    const notion = await getClient();
    const results: Array<Record<string, unknown>> = [];
    for (const op of operations) {
      if (op.op === "append") {
        const blocks = op.markdown
          ? parseMarkdownToBlocks(op.markdown)
          : (op.children ?? []);
        const r = await notion.blocks.children.append(
          asSdk<AppendBlockBody>({
            block_id: op.block_id,
            children: asSdk<AppendBlockChildren>(blocks),
          })
        );
        const canMapIds = r.results.length >= blocks.length;
        const newBlocks = canMapIds ? r.results.slice(0, blocks.length) : r.results;
        results.push(
          verbose
            ? { op: "append", appended: blocks.length, results: newBlocks.map((x) => slimBlock(x, true)) }
            : {
                op: "append",
                appended: blocks.length,
                ...(canMapIds ? { ids: newBlocks.map((x) => x.id) } : {}),
              }
        );
      } else if (op.op === "update") {
        let body: Record<string, unknown>;
        if (op.markdown) {
          const parsed = parseMarkdownToBlocks(op.markdown);
          if (parsed.length !== 1) throw new Error("update markdown must be a single block");
          body = extractTypedBody(parsed[0] as BlockTypedBody);
        } else if (op.data) {
          body = extractTypedBody(op.data as BlockTypedBody);
        } else {
          throw new Error("update requires markdown or data");
        }
        const r = await notion.blocks.update(
          asSdk<UpdateBlockBody>({ block_id: op.block_id, ...body })
        );
        results.push({ op: "update", block: slimBlock(r, verbose ?? false) });
      } else {
        const r = await notion.blocks.delete({ block_id: op.block_id });
        results.push({ op: "delete", block: slimBlock(r, verbose ?? false) });
      }
    }
    return { ok: true, data: { count: results.length, results } };
  }),
});
