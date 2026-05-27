import { APIResponseError } from "@notionhq/client";
import { AuthError } from "../services/auth.js";
import type { OperationError } from "../operations/types.js";

/**
 * Error codes from Notion API
 * @see https://developers.notion.com/reference/status-codes#error-codes
 */
export enum NotionErrorCode {
  InvalidJson = "invalid_json",
  InvalidRequestUrl = "invalid_request_url",
  InvalidRequest = "invalid_request",
  ValidationError = "validation_error",
  MissingVersion = "missing_version",
  UnsupportedVersion = "unsupported_version",
  UnsupportedExport = "unsupported_export",
  UnsupportedJsonType = "unsupported_json_type",
  UnsupportedJsonKey = "unsupported_json_key",
  Unauthorized = "unauthorized",
  InvalidApiKey = "invalid_api_key",
  RestrictedResource = "restricted_resource",
  InsufficientPermissions = "insufficient_permissions",
  ObjectNotFound = "object_not_found",
  ConflictError = "conflict_error",
  AlreadyExists = "already_exists",
  RateLimited = "rate_limited",
  InternalServerError = "internal_server_error",
  ServiceUnavailable = "service_unavailable",
  GatewayTimeout = "gateway_timeout",
  DatabaseConnectionUnavailable = "database_connection_unavailable",
}

/**
 * Codes that indicate a transient failure — the request either never ran or
 * the server is asking us to back off. Safe to retry with exponential backoff.
 * Shared by the dispatch retry wrapper and any caller that wants to classify
 * an error envelope without re-encoding the same rules.
 */
export const RETRYABLE_NOTION_CODES: ReadonlySet<NotionErrorCode> = new Set([
  NotionErrorCode.RateLimited,
  NotionErrorCode.InternalServerError,
  NotionErrorCode.ServiceUnavailable,
  NotionErrorCode.GatewayTimeout,
  NotionErrorCode.DatabaseConnectionUnavailable,
]);

export function isRetryableNotionCode(code: string | undefined): boolean {
  return code !== undefined && (RETRYABLE_NOTION_CODES as ReadonlySet<string>).has(code);
}

type ErrorEntry = { message: string; fix?: string };

const ERROR_MESSAGES: Record<string, ErrorEntry> = {
  [NotionErrorCode.InvalidJson]: {
    message: "The request body could not be decoded as JSON.",
    fix: "Pass the payload as an object, not as a JSON-encoded string.",
  },
  [NotionErrorCode.InvalidRequestUrl]: {
    message: "The request URL is not valid.",
  },
  [NotionErrorCode.InvalidRequest]: {
    message: "This request is not supported.",
  },
  [NotionErrorCode.ValidationError]: {
    message: "The request body does not match the schema for the expected parameters.",
    fix: "Call notion_describe with this operation name to fetch the schema, then retry. Check the 'path' field on the error for the specific bad property.",
  },
  [NotionErrorCode.MissingVersion]: {
    message: "The request is missing the required Notion-Version header.",
  },
  [NotionErrorCode.UnsupportedVersion]: {
    message: "The specified Notion-Version is not supported.",
  },
  [NotionErrorCode.UnsupportedExport]: {
    message: "The specified export type is not supported.",
  },
  [NotionErrorCode.UnsupportedJsonType]: {
    message: "The specified JSON type is not supported.",
  },
  [NotionErrorCode.UnsupportedJsonKey]: {
    message: "The specified JSON key is not supported.",
  },
  [NotionErrorCode.Unauthorized]: {
    message: "The bearer token is not valid.",
    fix: "Set the NOTION_TOKEN environment variable to a valid Notion integration token (starts with `ntn_` or `secret_`).",
  },
  [NotionErrorCode.InvalidApiKey]: {
    message: "The API key is invalid.",
    fix: "Generate a new internal integration token in Notion → Settings → Integrations → My integrations.",
  },
  [NotionErrorCode.RestrictedResource]: {
    message: "The resource is restricted and cannot be accessed with this token.",
    fix: "In Notion, open Settings → Connections → [your integration] → Capabilities and enable the missing scope (e.g. 'Read user information' for /users endpoints, 'Insert content' for block writes). For pages/databases, also confirm the integration is shared with the resource via the page's ••• → Add connections menu.",
  },
  [NotionErrorCode.InsufficientPermissions]: {
    message: "The bearer token does not have permission to perform this operation.",
    fix: "Open the integration in Notion → Settings → Connections and enable the missing capability, then share the target page/database with the integration.",
  },
  [NotionErrorCode.ObjectNotFound]: {
    message: "The requested resource does not exist.",
    fix: "Either the ID is wrong, the integration hasn't been shared with the page/database (use the page's ••• → Add connections menu in Notion), or the object is in trash.",
  },
  [NotionErrorCode.ConflictError]: {
    message: "The transaction could not be completed due to a conflict.",
    fix: "Retry the operation after a short delay.",
  },
  [NotionErrorCode.AlreadyExists]: {
    message: "The resource already exists.",
  },
  [NotionErrorCode.RateLimited]: {
    message: "The request was rate limited.",
    fix: "Retry later with exponential backoff. Notion limits to ~3 requests per second per integration.",
  },
  [NotionErrorCode.InternalServerError]: {
    message: "An unexpected error occurred on the Notion servers.",
    fix: "Retry the operation; if it persists, check status.notion.so.",
  },
  [NotionErrorCode.ServiceUnavailable]: {
    message: "The Notion service is unavailable.",
    fix: "Retry later with exponential backoff.",
  },
  [NotionErrorCode.GatewayTimeout]: {
    message: "The Notion gateway timed out before the request could complete.",
    fix: "Retry later with exponential backoff.",
  },
  [NotionErrorCode.DatabaseConnectionUnavailable]: {
    message: "The database connection is unavailable.",
    fix: "Retry later with exponential backoff.",
  },
};

function lookup(code: string): ErrorEntry {
  return ERROR_MESSAGES[code] ?? { message: "An unknown error occurred." };
}

export function toErrorEnvelope(error: unknown): OperationError {
  if (error instanceof APIResponseError) {
    const entry = lookup(error.code);
    const body = (error as APIResponseError & { body?: unknown }).body;
    return {
      code: error.code,
      message: entry.message + (error.message && error.message !== entry.message ? ` (${error.message})` : ""),
      ...(entry.fix ? { fix: entry.fix } : {}),
      ...(String(error.code) === NotionErrorCode.ValidationError && body
        ? { path: extractValidationPath(body) }
        : {}),
    };
  }
  if (error instanceof AuthError) {
    return {
      code: "auth_error",
      message: `Notion auth failed: ${error.message}`,
      fix: "Set NOTION_TOKEN env var, or configure OAuth credentials if using the auth gateway.",
    };
  }
  if (error instanceof Error) {
    return { code: "internal_error", message: error.message };
  }
  return { code: "unknown_error", message: String(error) };
}

function extractValidationPath(body: unknown): (string | number)[] | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const maybe = (body as { details?: unknown }).details;
  if (!Array.isArray(maybe)) return undefined;
  const first = maybe[0];
  if (
    typeof first === "object" &&
    first !== null &&
    Array.isArray((first as { path?: unknown }).path)
  ) {
    return (first as { path: (string | number)[] }).path;
  }
  return undefined;
}
