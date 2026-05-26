import { getClient } from "../services/notion.js";
import { BatchDeleteBlocksParams } from "../types/blocks.js";
import { handleNotionError } from "../utils/error.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const batchDeleteBlocks = async (
  params: BatchDeleteBlocksParams
): Promise<CallToolResult> => {
  try {
    const notion = await getClient();
    const results = [];

    for (const blockId of params.blockIds) {
      const response = await notion.blocks.delete({
        block_id: blockId,
      });

      results.push({
        blockId,
        success: true,
        response,
      });
    }

    return {
      content: [
        {
          type: "text",
          text: `Successfully deleted ${params.blockIds.length} blocks (moved to trash)`,
        },
        {
          type: "text",
          text: JSON.stringify(results, null, 2),
        },
      ],
    };
  } catch (error) {
    return handleNotionError(error);
  }
};
