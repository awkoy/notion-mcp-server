import { getClient } from "../services/notion.js";
import { RetrieveBlockParams } from "../types/blocks.js";
import { handleNotionError } from "../utils/error.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const retrieveBlock = async (
  params: RetrieveBlockParams
): Promise<CallToolResult> => {
  try {
    const notion = await getClient();
    const response = await notion.blocks.retrieve({
      block_id: params.blockId,
    });

    return {
      content: [
        {
          type: "text",
          text: "Block retrieved successfully! Note: If this block has children, use the retrieve_block_children endpoint to get the list of child blocks.",
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
