import { getClient } from "../services/notion.js";
import { BatchAppendBlockChildrenParams } from "../types/blocks.js";
import { handleNotionError } from "../utils/error.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const batchAppendBlockChildren = async (
  params: BatchAppendBlockChildrenParams
): Promise<CallToolResult> => {
  try {
    const notion = await getClient();
    const results = [];

    for (const operation of params.operations) {
      const response = await notion.blocks.children.append({
        block_id: operation.blockId,
        children: operation.children,
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
          text: `Successfully completed ${params.operations.length} append operations`,
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
