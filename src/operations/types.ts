import type { ZodType } from "zod";

export type OperationName =
  | "create_page"
  | "set_page_title"
  | "set_page_property"
  | "set_page_properties"
  | "archive_page"
  | "restore_page"
  | "search_pages"
  | "get_page"
  | "append_blocks"
  | "get_block"
  | "get_block_children"
  | "update_block"
  | "delete_block"
  | "batch_mixed_blocks"
  | "create_database"
  | "query_database"
  | "update_database"
  | "list_data_sources"
  | "get_data_source"
  | "update_data_source"
  | "list_comments"
  | "add_page_comment"
  | "add_discussion_comment"
  | "list_users"
  | "get_user"
  | "get_bot_user";

export type OperationResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: OperationError };

export type OperationError = {
  code: string;
  message: string;
  path?: (string | number)[];
  fix?: string;
};

export type BatchItemResult<T = unknown> =
  | { index: number; ok: true; data: T }
  | { index: number; ok: false; error: OperationError };

export type BatchResult<T = unknown> = {
  ok: boolean;
  summary: { total: number; succeeded: number; failed: number };
  results: BatchItemResult<T>[];
  rolled_back?: number;
};

export type BatchEnvelope<T> = {
  items: T[];
  atomic?: boolean;
  idempotency_key?: string;
};

export type RollbackFn = (createdData: unknown) => Promise<void>;

export type OperationDef<TParams = unknown, TResult = unknown> = {
  name: OperationName;
  description: string;
  schema: ZodType<TParams>;
  handler: (params: TParams) => Promise<OperationResult<TResult>>;
  batchable: boolean;
  example: unknown;
  exampleBatch?: unknown;
  rollback?: RollbackFn;
};
