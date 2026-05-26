import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { getClient } from "../services/notion.js";
import {
  AddDiscussionCommentParams,
  AddPageCommentParams,
  CommentsOperationParams,
  GetCommentsParams,
} from "../types/comments.js";
import { handleNotionError } from "../utils/error.js";

const registerGetCommentsTool = async (
  params: GetCommentsParams
): Promise<CallToolResult> => {
  try {
    const notion = await getClient();
    const response = await notion.comments.list(params);

    return {
      content: [
        {
          type: "text",
          text: `Comments retrieved successfully: ${response.results.length}`,
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

const registerAddPageCommentTool = async (
  params: AddPageCommentParams
): Promise<CallToolResult> => {
  try {
    const notion = await getClient();
    const response = await notion.comments.create(params);

    return {
      content: [
        {
          type: "text",
          text: `Comment created successfully: ${response.id}`,
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

const registerAddDiscussionCommentTool = async (
  params: AddDiscussionCommentParams
): Promise<CallToolResult> => {
  try {
    const notion = await getClient();
    const response = await notion.comments.create(params);

    return {
      content: [
        {
          type: "text",
          text: `Comment created successfully: ${response.id}`,
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

// Combined tool function that handles all comment operations
export const registerCommentsOperationTool = async (
  params: CommentsOperationParams
): Promise<CallToolResult> => {
  try {
    const { payload } = params;

    switch (payload.action) {
      case "get_comments":
        return registerGetCommentsTool(payload.params);
      case "add_page_comment":
        return registerAddPageCommentTool(payload.params);
      case "add_discussion_comment":
        return registerAddDiscussionCommentTool(payload.params);
      default:
        throw new Error(
          `Unsupported action, use one of the following: "get_comments", "add_page_comment", "add_discussion_comment"`
        );
    }
  } catch (error) {
    return handleNotionError(error);
  }
};
