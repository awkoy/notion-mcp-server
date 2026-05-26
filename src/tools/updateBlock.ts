import { getClient } from "../services/notion.js";
import { UpdateBlockParams } from "../types/blocks.js";
import { handleNotionError } from "../utils/error.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const updateBlock = async (
  params: UpdateBlockParams
): Promise<CallToolResult> => {
  try {
    const notion = await getClient();
    const response = await notion.blocks.update({
      block_id: params.blockId,
      ...params.data,
    });

    return {
      content: [
        {
          type: "text",
          text: `Block ${response.id} updated successfully`,
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
