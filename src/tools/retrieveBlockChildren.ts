import { getClient } from "../services/notion.js";
import { RetrieveBlockChildrenParams } from "../types/blocks.js";
import { handleNotionError } from "../utils/error.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const retrieveBlockChildren = async (
  params: RetrieveBlockChildrenParams
): Promise<CallToolResult> => {
  try {
    const notion = await getClient();
    const response = await notion.blocks.children.list({
      block_id: params.blockId,
      start_cursor: params.start_cursor,
      page_size: params.page_size,
    });

    return {
      content: [
        {
          type: "text",
          text: `Successfully retrieved ${response.results.length} children of block ${params.blockId}`,
        },
        {
          type: "text",
          text: `Has more: ${response.has_more ? "Yes" : "No"}${
            response.has_more && response.next_cursor
              ? `, Next cursor: ${response.next_cursor}`
              : ""
          }`,
        },
        {
          type: "text",
          text: JSON.stringify(response.results, null, 2),
        },
      ],
    };
  } catch (error) {
    return handleNotionError(error);
  }
};
