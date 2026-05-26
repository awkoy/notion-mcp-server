import { z } from "zod";
import { getClient } from "../services/notion.js";
import { register } from "./registry.js";
import { toErrorEnvelope } from "../utils/error.js";
import { slimBlock, slimList } from "../utils/slim.js";
import { parseMarkdownToBlocks } from "../markdown/parse.js";
import { TEXT_BLOCK_REQUEST_SCHEMA } from "../schema/blocks.js";

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
  handler: async ({ block_id, markdown, children, after, position, verbose }) => {
    try {
      const blocks = markdown ? parseMarkdownToBlocks(markdown) : children!;
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
      const response = await notion.blocks.children.append({
        block_id,
        children: blocks as never,
        ...(positionArg ? { position: positionArg } : {}),
      } as never);
      return {
        ok: true,
        data: {
          appended: response.results.length,
          results: response.results.map((r) => slimBlock(r, verbose ?? false)),
        },
      };
    } catch (error) {
      return { ok: false, error: toErrorEnvelope(error) };
    }
  },
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
  description: "Retrieve a single block by ID (metadata + type-specific body). For its children, use get_block_children.",
  batchable: true,
  schema: GetBlockParams,
  example: { block_id: "<block-id>" },
  exampleBatch: {
    items: [{ block_id: "<block-id-1>" }, { block_id: "<block-id-2>" }],
  },
  handler: async ({ block_id, verbose }) => {
    try {
      const notion = await getClient();
      const response = await notion.blocks.retrieve({ block_id });
      return { ok: true, data: slimBlock(response, verbose ?? false) };
    } catch (error) {
      return { ok: false, error: toErrorEnvelope(error) };
    }
  },
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
  description: "List child blocks under a page or block, paginated.",
  batchable: false,
  schema: GetBlockChildrenParams,
  example: { block_id: "<page-id>", page_size: 100 },
  handler: async ({ block_id, start_cursor, page_size, verbose }) => {
    try {
      const notion = await getClient();
      const response = await notion.blocks.children.list({
        block_id,
        start_cursor,
        page_size: page_size ?? 100,
      });
      return {
        ok: true,
        data: slimList(response, slimBlock, verbose ?? false),
      };
    } catch (error) {
      return { ok: false, error: toErrorEnvelope(error) };
    }
  },
});

// ──────────────────────────────────────────────────────────────────────────
// update_block
// ──────────────────────────────────────────────────────────────────────────

const UpdateBlockParams = z
  .object({
    block_id: z.string(),
    markdown: z
      .string()
      .optional()
      .describe("New content as markdown. Must parse to exactly one block matching the existing block's type."),
    data: TEXT_BLOCK_REQUEST_SCHEMA.optional().describe(
      "Full structured block envelope ({type, <type>: {...}}). Type must match the existing block."
    ),
    verbose: VERBOSE,
  })
  .refine((v) => Boolean(v.markdown) !== Boolean(v.data), {
    message: "Pass exactly one of `markdown` or `data`.",
  });

register({
  name: "update_block",
  description: "Update an existing block's content. Use markdown for prose blocks.",
  batchable: true,
  schema: UpdateBlockParams,
  example: { block_id: "<block-id>", markdown: "Updated paragraph text." },
  exampleBatch: {
    items: [
      { block_id: "<block-id-1>", markdown: "First update." },
      { block_id: "<block-id-2>", markdown: "Second update." },
    ],
  },
  handler: async ({ block_id, markdown, data, verbose }) => {
    try {
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
        const block = parsed[0] as Record<string, unknown>;
        const type = block.type as string;
        body = { [type]: block[type] };
      } else {
        const block = data as Record<string, unknown>;
        const type = block.type as string;
        body = { [type]: block[type] };
      }
      const notion = await getClient();
      const response = await notion.blocks.update({
        block_id,
        ...body,
      } as never);
      return { ok: true, data: slimBlock(response, verbose ?? false) };
    } catch (error) {
      return { ok: false, error: toErrorEnvelope(error) };
    }
  },
});

// ──────────────────────────────────────────────────────────────────────────
// delete_block
// ──────────────────────────────────────────────────────────────────────────

const DeleteBlockParams = z.object({ block_id: z.string(), verbose: VERBOSE });

register({
  name: "delete_block",
  description: "Archive (soft-delete) a block.",
  batchable: true,
  schema: DeleteBlockParams,
  example: { block_id: "<block-id>" },
  exampleBatch: { items: [{ block_id: "<block-id-1>" }, { block_id: "<block-id-2>" }] },
  handler: async ({ block_id, verbose }) => {
    try {
      const notion = await getClient();
      const response = await notion.blocks.delete({ block_id });
      return { ok: true, data: slimBlock(response, verbose ?? false) };
    } catch (error) {
      return { ok: false, error: toErrorEnvelope(error) };
    }
  },
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
    data: TEXT_BLOCK_REQUEST_SCHEMA.optional(),
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
  description: "Run a sequence of mixed block operations (append/update/delete) in order. For pure single-op batches, prefer the items[] form on append_blocks/update_block/delete_block.",
  batchable: false,
  schema: BatchMixedBlocksParams,
  example: {
    operations: [
      { op: "append", block_id: "<page-id>", markdown: "Header\n" },
      { op: "update", block_id: "<block-id>", markdown: "New text" },
      { op: "delete", block_id: "<other-block-id>" },
    ],
  },
  handler: async ({ operations, verbose }) => {
    try {
      const notion = await getClient();
      const results = [];
      for (const op of operations) {
        if (op.op === "append") {
          const blocks = op.markdown
            ? parseMarkdownToBlocks(op.markdown)
            : (op.children ?? []);
          const r = await notion.blocks.children.append({
            block_id: op.block_id,
            children: blocks as never,
          });
          results.push({ op: "append", appended: r.results.length });
        } else if (op.op === "update") {
          let body: Record<string, unknown>;
          if (op.markdown) {
            const parsed = parseMarkdownToBlocks(op.markdown);
            if (parsed.length !== 1) throw new Error("update markdown must be a single block");
            const block = parsed[0] as Record<string, unknown>;
            const type = block.type as string;
            body = { [type]: block[type] };
          } else if (op.data) {
            const block = op.data as Record<string, unknown>;
            const type = block.type as string;
            body = { [type]: block[type] };
          } else {
            throw new Error("update requires markdown or data");
          }
          const r = await notion.blocks.update({ block_id: op.block_id, ...body } as never);
          results.push({ op: "update", block: slimBlock(r, verbose ?? false) });
        } else {
          const r = await notion.blocks.delete({ block_id: op.block_id });
          results.push({ op: "delete", block: slimBlock(r, verbose ?? false) });
        }
      }
      return { ok: true, data: { count: results.length, results } };
    } catch (error) {
      return { ok: false, error: toErrorEnvelope(error) };
    }
  },
});
