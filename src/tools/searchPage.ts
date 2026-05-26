import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { getClient } from "../services/notion.js";
import { handleNotionError } from "../utils/error.js";
import { SearchPagesParams } from "../types/page.js";

export async function searchPages(
  params: SearchPagesParams
): Promise<CallToolResult> {
  try {
    const notion = await getClient();
    const response = await notion.search({
      query: params.query || "",
      sort: params.sort,
      start_cursor: params.start_cursor,
      page_size: params.page_size || 10,
    });

    const resultsText = JSON.stringify(response, null, 2);

    return {
      content: [
        {
          type: "text",
          text: `Found ${response.results.length} results. ${
            response.has_more ? "More results available." : ""
          }\n\n${resultsText}`,
        },
      ],
    };
  } catch (error) {
    return handleNotionError(error);
  }
}
