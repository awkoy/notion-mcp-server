import { dispatch } from "../dispatch/index.js";

export type NotionResourceKind = "page" | "database";

export type ResourceContent = {
  mimeType: string;
  text: string;
};

/**
 * Read a Notion entity for exposure as an MCP resource. Routes through the
 * normal dispatch path so resource reads share the same auth, rate limiting,
 * retry, and access gating as tool calls. A failed read returns the error
 * envelope as JSON rather than throwing, so the client still gets a body.
 */
export async function readNotionResource(
  kind: NotionResourceKind,
  id: string
): Promise<ResourceContent> {
  if (kind === "page") {
    const result = await dispatch("get_page_markdown", { page_id: id });
    if (result.ok && "data" in result) {
      const data = result.data as { markdown?: string };
      // A resource body has no room for warnings, so an incomplete page says
      // so in a comment ahead of the markdown, where the reader sees it first.
      const notes = result.warnings?.map((w) => `<!-- notion-mcp-server: ${w} -->\n`).join("") ?? "";
      return { mimeType: "text/markdown", text: notes + (data.markdown ?? "") };
    }
    return errorContent(result);
  }

  const result = await dispatch("get_data_source", { data_source_id: id });
  if (result.ok && "data" in result) {
    return { mimeType: "application/json", text: JSON.stringify(result.data) };
  }
  return errorContent(result);
}

function errorContent(result: unknown): ResourceContent {
  const error =
    result && typeof result === "object" && "error" in result
      ? (result as { error: unknown }).error
      : result;
  return { mimeType: "application/json", text: JSON.stringify(error) };
}
