import { getClient } from "../services/notion.js";
import { CreateDatabaseParams } from "../types/database.js";
import { handleNotionError } from "../utils/error.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const createDatabase = async (
  params: CreateDatabaseParams
): Promise<CallToolResult> => {
  try {
    const notion = await getClient();
    const response = await notion.databases.create(params);

    return {
      content: [
        {
          type: "text",
          text: `Database created successfully: ${response.id}`,
        },
      ],
    };
  } catch (error) {
    return handleNotionError(error);
  }
};
