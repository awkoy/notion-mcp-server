import { APIResponseError } from "@notionhq/client";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * Error codes from Notion API
 * @see https://developers.notion.com/reference/status-codes#error-codes
 */
export enum NotionErrorCode {
  // 400 errors
  InvalidJson = "invalid_json",
  InvalidRequestUrl = "invalid_request_url",
  InvalidRequest = "invalid_request",
  ValidationError = "validation_error",
  MissingVersion = "missing_version",
  UnsupportedVersion = "unsupported_version",
  UnsupportedExport = "unsupported_export",
  UnsupportedJsonType = "unsupported_json_type",
  UnsupportedJsonKey = "unsupported_json_key",
  // 401 errors
  Unauthorized = "unauthorized",
  InvalidApiKey = "invalid_api_key",
  // 403 errors
  RestrictedResource = "restricted_resource",
  InsufficientPermissions = "insufficient_permissions",
  // 404 errors
  ObjectNotFound = "object_not_found",
  // 409 errors
  ConflictError = "conflict_error",
  AlreadyExists = "already_exists",
  // 429 errors
  RateLimited = "rate_limited",
  // 500 errors
  InternalServerError = "internal_server_error",
  // 503 errors
  ServiceUnavailable = "service_unavailable",
  DatabaseConnectionUnavailable = "database_connection_unavailable",
}

const ERROR_MESSAGES: Record<string, string> = {
  [NotionErrorCode.InvalidJson]:
    "The request body could not be decoded as JSON",
  [NotionErrorCode.InvalidRequestUrl]: "The request URL is not valid",
  [NotionErrorCode.InvalidRequest]: "This request is not supported",
  [NotionErrorCode.ValidationError]:
    "The request body does not match the schema for the expected parameters",
  [NotionErrorCode.MissingVersion]:
    "The request is missing the required Notion-Version header",
  [NotionErrorCode.UnsupportedVersion]:
    "The specified version is not supported",
  [NotionErrorCode.UnsupportedExport]:
    "The specified export type is not supported",
  [NotionErrorCode.UnsupportedJsonType]:
    "The specified JSON type is not supported",
  [NotionErrorCode.UnsupportedJsonKey]:
    "The specified JSON key is not supported",
  [NotionErrorCode.Unauthorized]: "The bearer token is not valid",
  [NotionErrorCode.InvalidApiKey]: "The API key is invalid",
  [NotionErrorCode.RestrictedResource]:
    "The resource is restricted and cannot be accessed with this token",
  [NotionErrorCode.InsufficientPermissions]:
    "The bearer token does not have permission to perform this operation",
  [NotionErrorCode.ObjectNotFound]: "The requested resource does not exist",
  [NotionErrorCode.ConflictError]:
    "The transaction could not be completed due to a conflict",
  [NotionErrorCode.AlreadyExists]: "The resource already exists",
  [NotionErrorCode.RateLimited]:
    "The request was rate limited. Retry later with exponential backoff",
  [NotionErrorCode.InternalServerError]:
    "An unexpected error occurred on the Notion servers",
  [NotionErrorCode.ServiceUnavailable]:
    "The Notion service is unavailable. Retry later with exponential backoff",
  [NotionErrorCode.DatabaseConnectionUnavailable]:
    "The database connection is unavailable. Retry later with exponential backoff",
};

function getErrorMessage(
  notionErrorCode: string,
  defaultMessage?: string
): string {
  return (
    ERROR_MESSAGES[notionErrorCode] ||
    defaultMessage ||
    "An unknown error occurred"
  );
}

/**
 * Handles a Notion API error and returns a spec-compliant CallToolResult
 * with isError: true. Per MCP spec, tool execution errors are surfaced
 * via isError + a text content block describing the failure; the JSON-RPC
 * error envelope is reserved for protocol-level errors.
 */
export function handleNotionError(error: unknown): CallToolResult {
  if (error instanceof APIResponseError) {
    const code = error.code as string;
    const message = getErrorMessage(code, error.message);
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Error: ${message} (${code})`,
        },
      ],
    };
  }

  if (error instanceof Error) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Error: ${error.message}`,
        },
      ],
    };
  }

  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `Error: ${String(error)}`,
      },
    ],
  };
}
