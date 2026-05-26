import { getClient } from "../services/notion.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { handleNotionError } from "../utils/error.js";
import { ArchivePageParams, RestorePageParams } from "../types/page.js";

export async function archivePage(
  params: ArchivePageParams
): Promise<CallToolResult> {
  try {
    const notion = await getClient();
    const response = await notion.pages.update({
      page_id: params.pageId,
      archived: true,
    });

    return {
      content: [
        {
          type: "text",
          text: `Page archived successfully: ${response.id}`,
        },
      ],
    };
  } catch (error) {
    return handleNotionError(error);
  }
}

export async function restorePage(
  params: RestorePageParams
): Promise<CallToolResult> {
  try {
    const notion = await getClient();
    const response = await notion.pages.update({
      page_id: params.pageId,
      archived: false,
    });

    return {
      content: [
        {
          type: "text",
          text: `Page restored successfully: ${response.id}`,
        },
      ],
    };
  } catch (error) {
    return handleNotionError(error);
  }
}
