/**
 * Runtime interop for Notion SDK's CommonJS export shape.
 *
 * @notionhq/client 5.30+ emits a CJS build whose named exports cannot be
 * statically detected by Node 22 ESM. Node 24 accepts the named imports, but
 * that hides a fatal startup failure on supported Node 22 installations.
 * Import the CJS default and re-expose only its required runtime bindings.
 *
 * Keep type-only imports directly from @notionhq/client; they emit no JS.
 */
import notionSdk from "@notionhq/client";

export const {
  Client,
  APIErrorCode,
  APIResponseError,
  RequestTimeoutError,
  UnknownHTTPResponseError,
  isFullBlock,
  isFullComment,
  isFullDatabase,
  isFullDataSource,
  isFullPage,
  isFullUser,
} = notionSdk;

export type Client = InstanceType<typeof Client>;
export type APIResponseError = InstanceType<typeof APIResponseError>;
