import { getClient } from "../services/notion.js";
import { BatchUpdateBlocksParams } from "../types/blocks.js";
import { handleNotionError } from "../utils/error.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const batchUpdateBlocks = async (
  params: BatchUpdateBlocksParams
): Promise<CallToolResult> => {
  try {
    const notion = await getClient();
    const results = [];

    for (const operation of params.operations) {
      const response = await notion.blocks.update({
        block_id: operation.blockId,
        ...operation.data,
      });

      results.push({
        blockId: operation.blockId,
        success: true,
        response,
      });
    }

    return {
      content: [
        {
          type: "text",
          text: `Successfully updated ${params.operations.length} blocks`,
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
