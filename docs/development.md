# Development

## Setup

```bash
git clone https://github.com/awkoy/notion-mcp-server.git
cd notion-mcp-server
npm install
echo "NOTION_TOKEN=ntn_xxx" > .env   # gitignored

npm run build       # tsc -> build/
npm test            # vitest suite, against a mocked Notion client
npm run inspector   # MCP Inspector against the built binary
```

Point a client at the local build instead of npx:

```bash
claude mcp add notion -s user -e NOTION_TOKEN=ntn_xxx -- node "$(pwd)/build/index.js"
```

## How it's built

- TypeScript and the MCP TypeScript SDK v2 (`@modelcontextprotocol/server`, `@modelcontextprotocol/node`). stdio and Streamable HTTP transports, protocol revisions 2024-11-05 through 2026-07-28: `serveStdio` / `createMcpHandler` for the stateless 2026-07-28 path, the sessionful transport for the rest.
- Notion SDK `@notionhq/client` v5, pinned to `Notion-Version: 2026-03-11`.
- Zod 4 payload validation. Error envelopes carry draft-7 JSON Schema with `$defs` deduplication.
- Markdown to Notion blocks via `remark` / `remark-gfm`. Page-level markdown reads and writes use Notion's own markdown endpoints.
- A bounded-concurrency batch worker (default 3, max 10), a shared token-bucket rate limiter that paces every Notion request, and `withRetry` around every dispatched call. It is the only retry layer (the SDK client is built with `retry: false`): reads retry on 429, 529 and 5xx, writes only on 429 and 529 and only before anything was written, and a server's `Retry-After` is waited out as given.
- An in-memory idempotency cache (5-minute TTL, 512 entries).
- Slim shapers per entity type, with a `verbose: true` opt-out.
- Vitest covers the markdown parser, shapers, schema emitter, dispatcher, batch semantics (partial success, atomic rollback, idempotency), access control and the HTTP transport.

## End-to-end smoke test against a real workspace

`scripts/e2e.mjs` drives the built server over stdio against a real workspace: every read operation, the resources and prompts, `notion_describe` for every operation, and, with `--write`, every write operation inside one throwaway page.

```bash
npm run build
printf 'NOTION_TOKEN=ntn_...\nNOTION_PAGE_ID=<page the token can write under>\n' > .env   # gitignored
npm run e2e                      # read-only pass
npm run e2e -- --write           # full pass; creates one page under NOTION_PAGE_ID and trashes it at the end
npm run e2e -- --write --keep    # keep the test page for inspection
npm run e2e -- --modern          # any of the above as an MCP 2026-07-28 client (stateless envelope, input_required confirmations)
```

It prints a PASS/FAIL table per check, lists any operation the run didn't reach, and exits non-zero on failure. It is not part of CI.

## Benchmarks

The token numbers in the README come from [benchmarks/](../benchmarks), which has the method and the commands to reproduce them.
