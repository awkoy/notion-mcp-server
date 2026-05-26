import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { getClient } from "../services/notion.js";
import { handleNotionError } from "../utils/error.js";
import {
  GetUserParams,
  ListUsersParams,
  UsersOperationParams,
} from "../types/users.js";

export const registerGetListUsersTool = async (
  params: ListUsersParams
): Promise<CallToolResult> => {
  try {
    const notion = await getClient();
    const response = await notion.users.list(params);

    return {
      content: [
        {
          type: "text",
          text: `Users retrieved successfully: ${response.results.length}`,
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

export const registerGetUserTool = async (
  params: GetUserParams
): Promise<CallToolResult> => {
  try {
    const notion = await getClient();
    const response = await notion.users.retrieve(params);

    return {
      content: [
        {
          type: "text",
          text: `User retrieved successfully: ${response.id}`,
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

export const registerGetBotUserTool = async (): Promise<CallToolResult> => {
  try {
    const notion = await getClient();
    const response = await notion.users.me({});

    return {
      content: [
        {
          type: "text",
          text: `Bot user retrieved successfully: ${response.id}`,
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

// Combined tool function that handles all user operations
export const registerUsersOperationTool = async (
  params: UsersOperationParams
): Promise<CallToolResult> => {
  switch (params.payload.action) {
    case "list_users":
      return registerGetListUsersTool(params.payload.params);
    case "get_user":
      return registerGetUserTool(params.payload.params);
    case "get_bot_user":
      return registerGetBotUserTool();
    default:
      return handleNotionError(
        new Error(
          `Unsupported action, use one of the following: "list_users", "get_user", "get_bot_user"`
        )
      );
  }
};
