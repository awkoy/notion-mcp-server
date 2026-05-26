import { getClient } from "../services/notion.js";
import { UpdateDatabaseParams } from "../types/database.js";
import { handleNotionError } from "../utils/error.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const updateDatabase = async (
  params: UpdateDatabaseParams
): Promise<CallToolResult> => {
  try {
    const notion = await getClient();
    const response = await notion.databases.update(params);

    return {
      content: [
        {
          type: "text",
          text: `Database updated successfully: ${response.id}`,
        },
      ],
    };
  } catch (error) {
    return handleNotionError(error);
  }
};
