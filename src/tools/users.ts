import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { notion } from "../services/notion.js";
import { handleNotionError } from "../utils/error.js";
import { GetUserParams, ListUsersParams } from "../types/users.js";

export const registerGetListUsersTool = async (
  params: ListUsersParams
): Promise<CallToolResult> => {
  try {
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
