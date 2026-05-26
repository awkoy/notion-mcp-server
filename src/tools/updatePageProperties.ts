import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { getClient } from "../services/notion.js";
import { handleNotionError } from "../utils/error.js";
import { UpdatePagePropertiesParams } from "../types/page.js";

export async function updatePageProperties(
  params: UpdatePagePropertiesParams
): Promise<CallToolResult> {
  try {
    const notion = await getClient();
    const response = await notion.pages.update({
      page_id: params.pageId,
      properties: params.properties,
    });

    return {
      content: [
        {
          type: "text",
          text: `Page properties updated successfully: ${response.id}`,
        },
      ],
    };
  } catch (error) {
    return handleNotionError(error);
  }
}
