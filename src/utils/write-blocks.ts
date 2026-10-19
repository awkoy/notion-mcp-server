// Writes a block tree of any size and depth to Notion, which takes less per
// request: at most 100 blocks in any children array, 1000 blocks in all, and
// two levels of nesting under the blocks being sent (a block's children may
// have children, but those may not). Markdown easily goes past that: a long
// note, or a list nested three deep.
//
// A request carries the blocks that fit. A block whose children don't all fit
// is sent with the run of children that does, and the rest are appended to it
// once Notion has returned its id; that call applies the same rule one level
// down. Only the ids of a request's own top-level blocks are ever needed, and
// append returns those, so nothing is read back.

import type { Client } from "@notionhq/client";
import {
  asSdk,
  type AppendBlockBody,
  type AppendBlockChildren,
} from "./notion-types.js";

export const MAX_BLOCKS_PER_ARRAY = 100;
export const MAX_BLOCKS_PER_REQUEST = 1000;

type Block = Record<string, unknown>;
type AppendPosition =
  | { type: "start" }
  | { type: "end" }
  | { type: "after_block"; after_block: { id: string } };
export type WrittenBlock = Awaited<ReturnType<Client["blocks"]["children"]["append"]>>["results"][number];

function childrenOf(block: Block): Block[] {
  const type = block.type;
  if (typeof type !== "string") return [];
  const body = block[type];
  if (!body || typeof body !== "object") return [];
  const children = (body as { children?: unknown }).children;
  return Array.isArray(children) ? (children as Block[]) : [];
}

function withChildren(block: Block, children: Block[]): Block {
  const type = block.type as string;
  const { children: _dropped, ...body } = block[type] as Record<string, unknown>;
  return { ...block, [type]: children.length ? { ...body, children } : body };
}

type Fitted = { block: Block; size: number; later: Block[] };

/**
 * One top-level block as a request can carry it: with the leading children
 * whose own children have none, up to the array and request limits. `later`
 * holds the children from the first one that didn't fit, in order.
 */
function fitBlock(block: Block): Fitted {
  const kids = childrenOf(block);
  if (kids.length === 0) return { block, size: 1, later: [] };
  let size = 1;
  let n = 0;
  while (n < kids.length && n < MAX_BLOCKS_PER_ARRAY) {
    const grandkids = childrenOf(kids[n]);
    if (grandkids.length > MAX_BLOCKS_PER_ARRAY) break;
    if (grandkids.some((g) => childrenOf(g).length > 0)) break;
    if (size + 1 + grandkids.length > MAX_BLOCKS_PER_REQUEST) break;
    size += 1 + grandkids.length;
    n++;
  }
  if (n === kids.length) return { block, size, later: [] };
  return { block: withChildren(block, kids.slice(0, n)), size, later: kids.slice(n) };
}

export type BlockRequest = {
  /** The blocks to send, trimmed to what one request can carry. */
  send: Block[];
  /** Children to append to send[index] once Notion has returned its id. */
  later: Array<{ index: number; children: Block[] }>;
  /** Top-level blocks that go in the next request. */
  rest: Block[];
};

/** The next request's worth of `blocks`. Always sends at least one block. */
export function nextBlockRequest(blocks: Block[]): BlockRequest {
  const send: Block[] = [];
  const later: BlockRequest["later"] = [];
  let used = 0;
  let i = 0;
  for (; i < blocks.length && send.length < MAX_BLOCKS_PER_ARRAY; i++) {
    const fitted = fitBlock(blocks[i]);
    if (send.length > 0 && used + fitted.size > MAX_BLOCKS_PER_REQUEST) break;
    if (fitted.later.length) later.push({ index: send.length, children: fitted.later });
    send.push(fitted.block);
    used += fitted.size;
  }
  return { send, later, rest: blocks.slice(i) };
}

/**
 * Thrown when a write stops part way: `failure` is what stopped it, and
 * `written` the top-level blocks already in Notion.
 */
export class PartialWriteError extends Error {
  constructor(
    readonly failure: unknown,
    readonly written: WrittenBlock[]
  ) {
    super(failure instanceof Error ? failure.message : String(failure));
    this.name = "PartialWriteError";
  }
}

/**
 * Append `blocks` under `parentId`, in as many requests as Notion's limits
 * need. Returns the top-level blocks created, in order. With `position`
 * start or after_block, later requests go after the last block written.
 * A failure after the first request throws PartialWriteError.
 */
export async function appendBlockTree(
  notion: Pick<Client, "blocks">,
  parentId: string,
  blocks: Block[],
  position?: AppendPosition
): Promise<WrittenBlock[]> {
  const written: WrittenBlock[] = [];
  let rest = blocks;
  let at = position;
  try {
    while (rest.length > 0) {
      const request = nextBlockRequest(rest);
      const response = await notion.blocks.children.append(
        asSdk<AppendBlockBody>({
          block_id: parentId,
          children: asSdk<AppendBlockChildren>(request.send),
          ...(at ? { position: at } : {}),
        })
      );
      // Notion returns just the new blocks, except for position start, where
      // it returns the parent's children with the new ones first.
      const created = response.results.slice(0, request.send.length);
      written.push(...created);
      rest = request.rest;
      const placeAfter = rest.length > 0 && at !== undefined && at.type !== "end";
      if (request.later.length === 0 && !placeAfter) continue;
      if (created.length < request.send.length) {
        throw new Error(
          `Notion returned ${created.length} of ${request.send.length} new blocks, so the rest can't be placed.`
        );
      }
      for (const { index, children } of request.later) {
        await appendBlockTree(notion, created[index].id, children);
      }
      if (placeAfter) {
        at = { type: "after_block", after_block: { id: created[created.length - 1].id } };
      }
    }
  } catch (error) {
    const failure = error instanceof PartialWriteError ? error.failure : error;
    if (written.length === 0) throw failure;
    throw new PartialWriteError(failure, written);
  }
  return written;
}
