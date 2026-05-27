import type { ZodError } from "zod";
import type { OperationDef, OperationError } from "../operations/types.js";
import { emitJsonSchema } from "../schema/emit.js";
import { sliceJsonSchema, summarizeSchema } from "./schema-slice.js";

type ErrorWithSchema = OperationError & {
  operation: string;
  schema?: unknown;
  example?: unknown;
  example_batch?: unknown;
  issues?: { path: (string | number)[]; message: string }[];
};

// Top-level .refine() failures (XOR rules etc.) carry the whole-payload
// example as actionable guidance — the full JSON schema would only add
// noise. Skip the schema for those and any other top-level-only issue
// where the example is self-explanatory.
function shouldIncludeSchema(issues: ZodError["issues"]): boolean {
  return issues.some((i) => i.path.length > 0);
}

export function buildValidationError(
  def: OperationDef,
  zodError: ZodError
): ErrorWithSchema {
  const issues = zodError.issues.map((i) => ({
    path: i.path as (string | number)[],
    message: i.message,
  }));

  const firstPath = issues[0]?.path ?? [];
  const firstMsg = issues[0]?.message ?? "Validation failed";
  const includeSchema = shouldIncludeSchema(zodError.issues);

  // Slice the schema down to the failing field's subtree and summarize any
  // unions so the envelope stays small — the unsliced schema for ops like
  // set_page_property or update_database is 5-13KB.
  let schemaForError: unknown;
  if (includeSchema) {
    const fullSchema = emitJsonSchema(def.schema) as Record<string, unknown>;
    const sliced =
      firstPath.length > 0 ? sliceJsonSchema(fullSchema, firstPath) : fullSchema;
    schemaForError = summarizeSchema(sliced);
  }

  return {
    code: "validation_error",
    operation: def.name,
    message: `${firstMsg}${firstPath.length ? ` at ${firstPath.join(".")}` : ""}`,
    path: firstPath.length ? firstPath : undefined,
    issues,
    ...(includeSchema ? { schema: schemaForError } : {}),
    example: def.example,
    ...(def.exampleBatch ? { example_batch: def.exampleBatch } : {}),
    fix: includeSchema
      ? "Match the example shape. The schema above shows the failing field; call notion_describe for the full operation schema. For batch mode, wrap items in { items: [...] }."
      : "A working example is included above. Match the example shape and retry. For batch mode, wrap items in { items: [...] }.",
  };
}
