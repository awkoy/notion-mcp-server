import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { server } from "../server/index.js";
import { readNotionResource } from "./resources.js";
import { initOperations, getOperation } from "../operations/index.js";
import {
  isOperationAllowed,
  operationNotAllowedError,
  enabledOperationNames,
  enabledOperations,
  accessSummary,
} from "../operations/access.js";
import { dispatch } from "../dispatch/index.js";
import { emitJsonSchema } from "../schema/emit.js";
import { registerAllPrompts } from "../prompts/index.js";

function jsonContent(value: unknown): CallToolResult {
  // Compact JSON keeps the wire response small. Agents parse JSON either way,
  // and the ~30% bloat from indentation isn't worth paying for in every reply.
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return { content: [{ type: "text", text }] };
}

function errorContent(value: unknown): CallToolResult {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return { isError: true, content: [{ type: "text", text }] };
}

const EXECUTE_INPUT = {
  operation: z
    .string()
    .describe(
      "Operation name. See notion_describe for the schema of any operation, or read the notion://operations resource for the full menu. Common ops: set_page_title, append_blocks, get_page, search_pages, query_database."
    ),
  payload: z
    .record(z.string(), z.unknown())
    .describe(
      "Operation parameters. Pass either single-op fields directly, or { items: [...], atomic?, idempotency_key?, concurrency? } for batch."
    ),
};

const DESCRIBE_INPUT = {
  operation: z.string().describe("Operation name to describe."),
};

const EXECUTE_DESCRIPTION = `Execute a Notion operation by name.

Two ways to call:
  • Single: { operation: "set_page_title", payload: { page_id, title } }
  • Batch:  { operation: "set_page_title", payload: { items: [{page_id, title}, ...], atomic?: false, idempotency_key?: "...", concurrency?: 3 } }

If the payload is malformed, the error response includes the full schema + a working example so you can correct and retry in one round-trip. Call notion_describe(operation) ahead of time only for complex shapes (query_database filters, batch_mixed_blocks).

Most responses are slimmed by default. Pass verbose:true inside payload (single) or per-item (batch) to get the raw Notion SDK response.`;

const DESCRIBE_DESCRIPTION = `Return the JSON Schema and a working example for one operation. Use this BEFORE notion_execute when the payload shape is non-trivial (query filters, structured block trees, database property definitions). For simple ops, just call notion_execute — its errors carry the schema.`;

export async function registerAllTools(): Promise<void> {
  await initOperations();

  server.registerTool(
    "notion_execute",
    {
      title: "Notion Execute",
      description: EXECUTE_DESCRIPTION,
      inputSchema: EXECUTE_INPUT,
      annotations: {
        title: "Notion Execute",
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async ({ operation, payload }): Promise<CallToolResult> => {
      const result = await dispatch(operation, payload);
      // Batch results (with per-item results) always go back as structured data —
      // a partial success is a normal outcome of the tool, not a tool error.
      const isBatch = typeof result === "object" && result !== null && "summary" in result;
      if (isBatch || result.ok) return jsonContent(result);
      return errorContent(result);
    }
  );

  server.registerTool(
    "notion_describe",
    {
      title: "Notion Describe",
      description: DESCRIBE_DESCRIPTION,
      inputSchema: DESCRIBE_INPUT,
      annotations: {
        title: "Notion Describe",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ operation }): Promise<CallToolResult> => {
      const def = getOperation(operation);
      if (!def) {
        return errorContent({
          ok: false,
          error: {
            code: "unknown_operation",
            message: `Unknown operation: "${operation}".`,
            fix: `Available: ${enabledOperationNames().join(", ")}`,
          },
        });
      }
      if (!isOperationAllowed(operation)) {
        return errorContent({ ok: false, error: operationNotAllowedError(operation) });
      }
      return jsonContent({
        name: def.name,
        description: def.description,
        batchable: def.batchable,
        schema: emitJsonSchema(def.schema),
        example: def.example,
        ...(def.exampleBatch ? { example_batch: def.exampleBatch } : {}),
      });
    }
  );

  // Cheat-sheet resource: a markdown table of every operation
  server.registerResource(
    "operations-index",
    "notion://operations",
    {
      title: "Notion operations index",
      description: "Markdown table of every supported operation, batchability, and one-line description.",
      mimeType: "text/markdown",
    },
    async () => ({
      contents: [
        {
          uri: "notion://operations",
          mimeType: "text/markdown",
          text: renderOperationsIndex(),
        },
      ],
    })
  );

  // Dynamic resources: let clients @-mention / attach a Notion page or database
  // by id. Pages come back as markdown; databases as their (slim) schema JSON.
  const firstVar = (v: string | string[]): string => (Array.isArray(v) ? v[0] : v);

  server.registerResource(
    "notion-page",
    new ResourceTemplate("notion://page/{pageId}", { list: undefined }),
    {
      title: "Notion page (markdown)",
      description:
        "Read any Notion page as markdown by id — notion://page/<page_id>.",
      mimeType: "text/markdown",
    },
    async (uri, variables) => {
      const { mimeType, text } = await readNotionResource(
        "page",
        firstVar(variables.pageId)
      );
      return { contents: [{ uri: uri.href, mimeType, text }] };
    }
  );

  server.registerResource(
    "notion-database",
    new ResourceTemplate("notion://database/{dataSourceId}", { list: undefined }),
    {
      title: "Notion database (schema)",
      description:
        "Read a Notion data source's schema by id — notion://database/<data_source_id>.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const { mimeType, text } = await readNotionResource(
        "database",
        firstVar(variables.dataSourceId)
      );
      return { contents: [{ uri: uri.href, mimeType, text }] };
    }
  );

  registerAllPrompts();

  const s = accessSummary();
  console.error(
    `Operation access: ${s.enabled}/${s.total} enabled (allow=${s.allow}; block=${s.block}${s.readOnly ? "; read-only" : ""})`
  );
}

function renderOperationsIndex(): string {
  const lines = [
    "# Notion MCP — Operations",
    "",
    "Call `notion_execute({operation, payload})` with one of these. Use `notion_describe({operation})` for the full schema.",
    "",
    "| Operation | Batchable | Description |",
    "| --- | --- | --- |",
  ];
  for (const def of enabledOperations()) {
    lines.push(`| \`${def.name}\` | ${def.batchable ? "yes" : "no"} | ${def.description} |`);
  }
  // Only document the query_database filter DSL when that op is actually enabled —
  // otherwise the menu advertises a disabled operation.
  if (!isOperationAllowed("query_database")) {
    return lines.join("\n");
  }
  lines.push("", "## `query_database` WHERE DSL", "");
  lines.push(
    "`query_database.where` is a compact DSL that compiles to the Notion filter object. AND-by-default at the top level; nest `and`/`or`/`not` (case-insensitive — `AND`/`OR`/`NOT` also work) for boolean groups, prefix scalars with `__type` to force the property type, or fall back to raw `filter` for anything the DSL can't express.",
    "",
    "Common shapes:",
    "",
    "```jsonc",
    "// Single equality (property type inferred from value, or from data source schema via __type):",
    "{ \"where\": { \"Status\": \"Open\" } }",
    "",
    "// AND of multiple properties (top-level keys are implicit AND):",
    "{ \"where\": { \"Status\": \"Done\", \"Done\": true } }",
    "",
    "// Explicit operator on one property:",
    "{ \"where\": { \"Priority\": { \"gte\": 3 } } }",
    "",
    "// Boolean groups (lowercase or uppercase — both work):",
    "{ \"where\": { \"or\": [ { \"Status\": \"Open\" }, { \"Status\": \"In progress\" } ] } }",
    "{ \"where\": { \"and\": [ { \"Status\": \"Done\" }, { \"Priority\": { \"gte\": 5 } } ] } }",
    "{ \"where\": { \"not\": { \"Status\": \"Done\" } } }",
    "",
    "// in / notIn fan out to OR / AND of equals:",
    "{ \"where\": { \"Status\": { \"in\": [\"Open\", \"In progress\"] } } }",
    "",
    "// Force property type when value shape is ambiguous (e.g. a string that's actually a multi_select tag):",
    "{ \"where\": { \"Tags\": { \"__type\": \"multi_select\", \"eq\": \"alpha\" } } }",
    "{ \"where\": { \"Created\": { \"__type\": \"date\", \"on_or_after\": \"2026-01-01\" } } }",
    "```",
    "",
    "If a column is literally named `and`/`or`/`not`, wrap it as an operator object (e.g. `{ \"and\": { \"__type\": \"select\", \"eq\": \"x\" } }`) so it isn't parsed as a combinator. For anything the DSL can't express, pass `filter` (raw Notion filter object) instead of `where`."
  );
  return lines.join("\n");
}
