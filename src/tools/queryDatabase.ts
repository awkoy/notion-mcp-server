import { getClient } from "../services/notion.js";
import { QueryDatabaseParams } from "../types/database.js";
import { handleNotionError } from "../utils/error.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const queryDatabase = async (
  params: QueryDatabaseParams
): Promise<CallToolResult> => {
  try {
    const notion = await getClient();
    const response = await notion.databases.query(params);

    return {
      content: [
        {
          type: "text",
          text: `Database queried successfully. Found ${response.results.length} results.`,
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
