import { getClient } from "../services/notion.js";
import { CreatePageParams } from "../types/page.js";
import { handleNotionError } from "../utils/error.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const registerCreatePageTool = async (
  params: CreatePageParams
): Promise<CallToolResult> => {
  try {
    const notion = await getClient();
    const response = await notion.pages.create(params);

    return {
      content: [
        {
          type: "text",
          text: `Page created successfully: ${response.id}`,
        },
      ],
    };
  } catch (error) {
    return handleNotionError(error);
  }
};
