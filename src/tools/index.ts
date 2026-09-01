import type { CallToolResult, McpServer, ServerContext } from "@modelcontextprotocol/server";
import { ResourceTemplate } from "@modelcontextprotocol/server";
import { z } from "zod";
import { readNotionResource } from "./resources.js";
import { getOperation } from "../operations/index.js";
import type { OperationAccess } from "../operations/types.js";
import {
  isOperationAllowed,
  operationNotAllowedError,
  enabledOperationNames,
  enabledOperations,
} from "../operations/access.js";
import { dispatch } from "../dispatch/index.js";
import { emitJsonSchema } from "../schema/emit.js";
import { registerAllPrompts } from "../prompts/index.js";
import { confirmDestructiveCall } from "./confirm.js";
import { log } from "../utils/log.js";

// An operation that returns non-text content puts MCP content blocks under
// `data._mcp_content`, and they leave the JSON envelope here. get_image is the
// only one today: a model cannot see an image it receives as a URL string.
function mcpContentOf(value: unknown): CallToolResult["content"] | undefined {
  const data = (value as { ok?: boolean; data?: unknown })?.data;
  const blocks = (data as { _mcp_content?: unknown })?._mcp_content;
  return Array.isArray(blocks) && blocks.length
    ? (blocks as CallToolResult["content"])
    : undefined;
}

function jsonContent(value: unknown): CallToolResult {
  const content = mcpContentOf(value);
  if (content) return { content };
  // Compact JSON keeps the wire response small. Agents parse JSON either way,
  // and the ~30% bloat from indentation isn't worth paying for in every reply.
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return { content: [{ type: "text", text }] };
}

function errorContent(value: unknown): CallToolResult {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return { isError: true, content: [{ type: "text", text }] };
}

/** The MCP tool that runs an operation of the given access class. */
export const TOOL_BY_ACCESS: Record<OperationAccess, string> = {
  read: "notion_read",
  write: "notion_write",
};

const PAYLOAD_FIELD = z
  .record(z.string(), z.unknown())
  .describe(
    "Operation parameters. Pass either single-op fields directly, or { items: [...], atomic?, idempotency_key?, concurrency? } for batch."
  );

// The error a client sees when it names an operation the enum does not carry.
// The SDK reports a schema mismatch as an InvalidParams JSON-RPC error whose
// text is zod's message, so the message must say what to do instead: the
// most common mistake is sending a write op to notion_read (or vice versa).
function operationIssue(
  input: unknown,
  tool: string,
  access: OperationAccess,
  valid: readonly string[]
): string {
  const name = typeof input === "string" ? input : JSON.stringify(input);
  const def = typeof input === "string" ? getOperation(input) : undefined;
  if (def && !isOperationAllowed(def.name)) {
    return `"${name}" is disabled by this server's configuration (operation_not_allowed).`;
  }
  if (def && def.access !== access) {
    return `"${name}" is a ${def.access} operation: call ${TOOL_BY_ACCESS[def.access]} instead of ${tool}.`;
  }
  return `Unknown operation "${name}". ${tool} accepts: ${valid.join(", ")}.`;
}

// `operation` is an enum of exactly the operations this tool runs on this
// server, so the tool list doubles as the menu and a client cannot even send
// a name that is not enabled here. Custom error text keeps that mistake a
// one-round-trip fix.
function operationField(
  tool: string,
  access: OperationAccess,
  names: string[],
  description: string
) {
  return z
    .enum(names, { error: (issue) => operationIssue(issue.input, tool, access, names) })
    .describe(description);
}

const READ_DESCRIPTION = `Run one Notion read operation by name. Nothing is modified.

Call: { operation, payload } — payload carries that operation's fields. Common: search_pages { query }, get_page { page_id }, get_page_markdown { page_id }, query_database { database_id, where? }, get_block_children { block_id }.

Responses are slimmed; pass verbose:true in payload for the raw Notion object. Every id field (page_id, block_id, database_id, view_id, …) also accepts a Notion URL, as copied from Share → Copy link. A block link's #fragment is used for block_id fields and a database link's ?v= for view_id fields.

If the payload is malformed, the error response includes the schema + a working example so you can correct and retry in one round-trip. Call notion_describe(operation) ahead of time only for complex shapes (query_database filters).`;

const WRITE_DESCRIPTION = `Run one Notion write operation by name. Archive, trash and delete operations remove content — confirm with the user before running them.

Two ways to call:
  • Single: { operation: "set_page_title", payload: { page_id, title } }
  • Batch:  { operation: "set_page_title", payload: { items: [{page_id, title}, ...], atomic?: false, idempotency_key?: "...", concurrency?: 3 } }
create_page, append_blocks, update_block and update_page_markdown also take a markdown string.

Responses are slimmed; pass verbose:true inside payload (single) or per item (batch) for the raw Notion object. Every id field (page_id, block_id, database_id, view_id, …) also accepts a Notion URL, as copied from Share → Copy link.

If the payload is malformed, the error response includes the schema + a working example so you can correct and retry in one round-trip. Call notion_describe(operation) ahead of time only for complex shapes (block trees, database property definitions, batch_mixed_blocks).`;

const DESCRIBE_DESCRIPTION = `Return the JSON Schema and a working example for one operation, plus which tool runs it (notion_read or notion_write). Use this BEFORE calling the operation when the payload shape is non-trivial (query filters, structured block trees, database property definitions). For simple ops, just call it — errors carry the schema.`;

/**
 * Shared body of notion_read and notion_write: optional confirmation, dispatch,
 * one log line, and the ok / error envelope.
 */
async function runOperation(
  server: McpServer,
  ctx: ServerContext,
  tool: string,
  operation: string,
  payload: Record<string, unknown>
): Promise<CallToolResult> {
  // With NOTION_CONFIRM_DESTRUCTIVE on, a destructive call first asks the
  // user through elicitation; a "no" (or a client that cannot ask) comes
  // back as an error envelope and nothing is dispatched.
  const denied = await confirmDestructiveCall(server, ctx, operation, payload);
  if (denied) return errorContent({ ok: false, error: denied });
  const started = performance.now();
  const result = await dispatch(operation, payload);
  const items = "summary" in result ? result.summary.total : undefined;
  const ms = Math.round(performance.now() - started);
  // One line per call for a client at `debug` (and for stderr): what ran,
  // whether it succeeded, how long — never the payload or any page content.
  // Not ctx.mcpReq.log: that forwards debug lines to a client that never set
  // a level; the level filter lives in utils/log.ts.
  log.debug(
    `${tool} ${operation}${items === undefined ? "" : ` batch=${items}`} ${result.ok ? "ok" : "error"} ${ms}ms`,
    {
      tool,
      operation,
      batch: items !== undefined,
      ...(items === undefined ? {} : { items }),
      ms,
      ok: result.ok,
    },
    { server, ctx }
  );
  // Batch results (with per-item results) always go back as structured data —
  // a partial success is a normal outcome of the tool, not a tool error.
  if (items !== undefined || result.ok) return jsonContent(result);
  return errorContent(result);
}

function registerOperationTool(server: McpServer, access: OperationAccess): void {
  const names = enabledOperations()
    .filter((def) => def.access === access)
    .map((def) => def.name);
  // A tool with nothing to run is not advertised at all: under NOTION_READ_ONLY
  // (or an allow-list without writes) the client sees no notion_write, so it
  // has nothing to ask permission for and nothing to describe.
  if (names.length === 0) return;
  const tool = TOOL_BY_ACCESS[access];
  const read = access === "read";
  server.registerTool(
    tool,
    {
      title: read ? "Notion Read" : "Notion Write",
      description: read ? READ_DESCRIPTION : WRITE_DESCRIPTION,
      inputSchema: z.object({
        operation: operationField(
          tool,
          access,
          names,
          `The ${access} operation to run. This list is the complete menu of ${access} operations enabled on this server; notion_describe(operation) returns any operation's full schema.`
        ),
        payload: PAYLOAD_FIELD,
      }),
      annotations: read
        ? {
            title: "Notion Read",
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
          }
        : {
            title: "Notion Write",
            readOnlyHint: false,
            destructiveHint: true,
            openWorldHint: true,
          },
    },
    ({ operation, payload }, ctx) => runOperation(server, ctx, tool, operation, payload)
  );
}

export function registerAllTools(server: McpServer): void {
  registerOperationTool(server, "read");
  registerOperationTool(server, "write");

  // notion_describe takes a plain string: the read and write enums above are
  // already the menu, and repeating all of them here would cost every session
  // another ~1 KB of tool list for nothing (an unknown name lists them anyway).
  if (enabledOperationNames().length === 0) return;
  server.registerTool(
    "notion_describe",
    {
      title: "Notion Describe",
      description: DESCRIBE_DESCRIPTION,
      inputSchema: z.object({
        operation: z
          .string()
          .describe("Operation name to describe, as listed by notion_read / notion_write."),
      }),
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
        tool: TOOL_BY_ACCESS[def.access],
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

  registerAllPrompts(server);
}

function renderOperationsIndex(): string {
  const lines = [
    "# Notion MCP — Operations",
    "",
    "Call `notion_read({operation, payload})` for a read operation and `notion_write({operation, payload})` for a write operation — the Tool column says which. Use `notion_describe({operation})` for the full schema.",
    "",
    "| Operation | Tool | Batchable | Description |",
    "| --- | --- | --- | --- |",
  ];
  for (const def of enabledOperations()) {
    lines.push(
      `| \`${def.name}\` | ${TOOL_BY_ACCESS[def.access]} | ${def.batchable ? "yes" : "no"} | ${def.description} |`
    );
  }
  // Document the WHERE DSL when any operation that accepts it is enabled.
  // query_database, create_view, and update_view all take the same `where`.
  const whereOps = ["query_database", "create_view", "update_view"].filter((op) =>
    isOperationAllowed(op)
  );
  if (whereOps.length === 0) {
    return lines.join("\n");
  }
  lines.push("", "## WHERE filter DSL", "");
  lines.push(
    `The same \`where\` DSL is accepted by ${whereOps.map((o) => `\`${o}\``).join(", ")}. It is a compact shorthand that compiles to the Notion filter object. AND-by-default at the top level; nest \`and\`/\`or\`/\`not\` (case-insensitive — \`AND\`/\`OR\`/\`NOT\` also work) for boolean groups, prefix scalars with \`__type\` to force the property type, or fall back to raw \`filter\` for anything the DSL can't express.`,
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
