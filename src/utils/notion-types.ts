// Bridge between Zod-validated request shapes and the SDK's strict
// discriminated-union request types. Zod can describe loose shapes
// (z.record, z.unknown), but `@notionhq/client` request types use
// branded discriminated unions that Zod inference can't preserve.
//
// Each helper below is a single typed boundary cast: the runtime payload
// has already been validated by Zod; the cast only tells TypeScript what
// the SDK expects on the wire. Prefer these over `as never` so the cast
// target stays visible and grep-able.

import { Client } from "@notionhq/client";
import type {
  AppendBlockChildrenParameters,
  CreateCommentParameters,
  CreateDatabaseParameters,
  CreateFileUploadParameters,
  CreatePageParameters,
  MovePageParameters,
  QueryDataSourceParameters,
  SendFileUploadParameters,
  UpdateBlockParameters,
  UpdateCommentParameters,
  UpdateDatabaseParameters,
  UpdateDataSourceParameters,
  UpdatePageParameters,
} from "@notionhq/client";

type ClientType = InstanceType<typeof Client>;

export type CreatePageBody = CreatePageParameters;
export type UpdatePageBody = UpdatePageParameters;
export type MovePageBody = MovePageParameters;
export type UpdatePageMarkdownBody = Parameters<ClientType["pages"]["updateMarkdown"]>[0];
export type CreateDatabaseBody = CreateDatabaseParameters;
export type UpdateDatabaseBody = UpdateDatabaseParameters;
export type QueryDataSourceBody = QueryDataSourceParameters;
export type UpdateDataSourceBody = UpdateDataSourceParameters;
export type AppendBlockBody = AppendBlockChildrenParameters;
export type AppendBlockChildren = AppendBlockChildrenParameters["children"];
export type UpdateBlockBody = UpdateBlockParameters;
export type CreateCommentBody = CreateCommentParameters;
export type UpdateCommentBody = UpdateCommentParameters;
export type CreateFileUploadBody = CreateFileUploadParameters;
export type SendFileUploadBody = SendFileUploadParameters;

/**
 * Cast a Zod-validated payload to its SDK request shape. The runtime value
 * has already been narrowed by the schema; this only widens the static type.
 */
export function asSdk<T>(value: unknown): T {
  return value as T;
}
