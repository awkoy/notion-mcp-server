# Context-overhead benchmark

How much of an agent's context window does the Notion tool surface consume **before it does any work**? Every MCP client sends the server's `tools/list` payload — tool names, descriptions, and JSON input schemas — into the model's context on connection, and it stays there for the whole session. Fewer, smaller schemas = more room for the actual task.

This benchmark measures that payload for **this server** (2 tools) against the **official open-source server** [`@notionhq/notion-mcp-server`](https://www.npmjs.com/package/@notionhq/notion-mcp-server) (one tool per REST endpoint).

## Method

1. Drive each server through the MCP stdio handshake and capture its real `tools/list` response (`list-tools.mjs`). No Notion token needed — schema listing is unauthenticated.
2. Serialize each tool into the shape a client forwards to the model's tool-use API (`{name, description, input_schema}`) and count tokens (`count.py`).
3. Tokenizer: `o200k_base` (GPT-4o/4.1) via `tiktoken` — a public, modern proxy for LLM context cost. Anthropic's tokenizer isn't public; absolute counts shift slightly by model, the **ratio** is stable.

## Results

Measured against `@notionhq/notion-mcp-server` (Notion-Version `2022-06-28`), this server at v2.10.1.

### Static footprint — always in context, every request

| Server | Tools | Tool-schema tokens |
| --- | --- | --- |
| Official open-source server | 24 | **17,163** |
| This server | 2 | **422** |

**97.5% smaller — 40.7× less** context spent on tool schemas at connection.

The official server front-loads all 24 endpoint schemas whether or not you use them. This server exposes two tools — `notion_execute` (dispatches 44 operations) and `notion_describe` (returns any operation's schema on demand) — so the full operation catalog never sits in context.

### Realistic sessions — static 422 + `notion_describe` only for operations actually used

| Task | Operations described | Tokens | vs. 17,163 |
| --- | --- | --- | --- |
| Read a page | `get_page` | 582 | 97% less |
| Search + read | `search_pages`, `get_page` | 802 | 95% less |
| Query a database | `query_database` | 796 | 95% less |
| Write: page + blocks | `create_page`, `append_blocks` | 2,270 | 87% less |
| Typical mixed (4 ops) | `get_page`, `search_pages`, `append_blocks`, `query_database` | 1,424 | 92% less |
| Heavy (8 ops) | 8 distinct operations | 3,578 | 79% less |

`notion_describe` output averages ~650 tokens/operation (69 for a trivial op like `delete_comment`, up to ~4,500 for `batch_mixed_blocks`). Often the agent skips `describe` entirely — `notion_execute` returns self-healing validation errors that let the model correct its own payload in one turn.

### Honest worst case

Describing **all 44 operations** would cost ~29,000 tokens — more than the official server's 17,163. You would never do this: the design pays only for what a task touches, while the official server pays its full 17,163 on every connection regardless. Note also this server covers **44 operations vs. the official 24 endpoints**, with richer per-operation schemas (batch semantics, idempotency), so even per-operation the payloads aren't strictly like-for-like.

## Reproduce

```bash
# From the repo root, with the server built (npm run build):
cd benchmarks
NOTION_TOKEN=ntn_dummy node list-tools.mjs awkoy node ../build/index.js > awkoy.json
OPENAPI_MCP_HEADERS='{"Authorization":"Bearer ntn_dummy","Notion-Version":"2022-06-28"}' \
  node list-tools.mjs notion-official npx -y @notionhq/notion-mcp-server > official.json
python3 count.py                       # static footprint + reduction
node describe-all.mjs > all-describe.json   # on-demand describe costs
```

Requires `tiktoken` (`pip install tiktoken`).
