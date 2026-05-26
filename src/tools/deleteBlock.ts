import { getClient } from "../services/notion.js";
import { DeleteBlockParams } from "../types/blocks.js";
import { handleNotionError } from "../utils/error.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const deleteBlock = async (
  params: DeleteBlockParams
): Promise<CallToolResult> => {
  try {
    const notion = await getClient();
    const response = await notion.blocks.delete({
      block_id: params.blockId,
    });

    return {
      content: [
        {
          type: "text",
          text: `Block ${params.blockId} deleted (moved to trash) successfully`,
        },
        {
          type: "text",
          text: JSON.stringify(response, null, 2),
        },
      ],
    };
  } catch (error) {
    return handleNotionError(error);
  }
};
