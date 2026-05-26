import { getClient } from "../services/notion.js";
import { BatchMixedOperationsParams } from "../types/blocks.js";
import { handleNotionError } from "../utils/error.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const batchMixedOperations = async (
  params: BatchMixedOperationsParams
): Promise<CallToolResult> => {
  try {
    const notion = await getClient();
    const results = [];
    const operationCounts = {
      append: 0,
      update: 0,
      delete: 0,
    };

    for (const op of params.operations) {
      let response;

      switch (op.operation) {
        case "append":
          response = await notion.blocks.children.append({
            block_id: op.blockId,
            children: op.children,
          });
          operationCounts.append++;
          break;

        case "update":
          response = await notion.blocks.update({
            block_id: op.blockId,
            ...op.data,
          });
          operationCounts.update++;
          break;

        case "delete":
          response = await notion.blocks.delete({
            block_id: op.blockId,
          });
          operationCounts.delete++;
          break;
      }

      results.push({
        operation: op.operation,
        blockId: op.blockId,
        success: true,
        response,
      });
    }

    return {
      content: [
        {
          type: "text",
          text: `Successfully performed ${params.operations.length} operations (${operationCounts.append} append, ${operationCounts.update} update, ${operationCounts.delete} delete)`,
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
