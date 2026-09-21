# Context-overhead benchmark

How much of an agent's context window does the Notion tool surface consume **before it does any work**? Every MCP client sends the server's `tools/list` payload — tool names, descriptions, and JSON input schemas — into the model's context on connection, and it stays there for the whole session. Fewer, smaller schemas = more room for the actual task.

This benchmark measures that payload for **this server** (3 tools) against the **official open-source server** [`@notionhq/notion-mcp-server`](https://www.npmjs.com/package/@notionhq/notion-mcp-server) (one tool per REST endpoint).

## Method

1. Drive each server through the MCP stdio handshake and capture its real `tools/list` response (`list-tools.mjs`). No Notion token needed — schema listing is unauthenticated.
2. Serialize each tool into the shape a client forwards to the model's tool-use API (`{name, description, input_schema}`) and count tokens (`count.py`).
3. Tokenizer: `o200k_base` (GPT-4o/4.1) via `tiktoken` — a public, modern proxy for LLM context cost. Anthropic's tokenizer isn't public; absolute counts shift slightly by model, the **ratio** is stable.

## Results

Re-measured 2026-09-21: this server at v3.1.0 against `@notionhq/notion-mcp-server` 2.5.2 (Notion-Version `2025-09-03`). Both halves — the static footprint and the per-operation `notion_describe` costs — come from that one run, so the numbers below are directly comparable to each other.

### Static footprint — always in context, every request

| Server | Tools | Tool-schema tokens |
| --- | --- | --- |
| Official open-source server | 24 | **17,163** |
| This server | 3 | **1,005** |

**94.1% smaller — 17.1× less** context spent on tool schemas at connection.

The official server front-loads all 24 endpoint schemas whether or not you use them. This server exposes three tools — `notion_read` and `notion_write` (which between them dispatch every operation, each carrying an enum of its operation names) and `notion_describe` (returns any operation's schema on demand) — so the full operation catalog never sits in context. The two enums are ~330 of the 1,005 tokens: that is what naming all 48 operations up front costs.

### Realistic sessions — static 1,005 + `notion_describe` only for operations actually used

| Task | Operations described | Tokens | vs. 17,163 |
| --- | --- | --- | --- |
| Read a page | `get_page` | 1,171 | 93% less |
| Search + read | `search_pages`, `get_page` | 1,411 | 92% less |
| Query a database | `query_database` | 1,634 | 90% less |
| Typical mixed (4 ops) | `get_page`, `search_pages`, `append_blocks`, `query_database` | 2,367 | 86% less |
| Write: page + blocks | `create_page`, `append_blocks` | 4,917 | 71% less |
| Heavy (8 ops) | `search_pages`, `get_page`, `query_database`, `create_page`, `append_blocks`, `set_page_properties`, `update_block`, `list_comments` | 9,198 | 46% less |

The spread between those rows is the thing to understand, and it is wide. Per operation, `notion_describe` runs from 75 tokens (`delete_comment`) to 3,592 (`create_database`), median 166, mean 565. Five operations — `create_database`, `create_page`, `update_database`, `update_data_source`, `set_page_properties` — account for 59% of the entire catalog, because they carry the full property-definition and block-content schemas. So what a session costs depends far more on *which* operations it touches than on how many: one `create_page` costs as much as twenty `get_page` calls.

Often the agent skips `describe` entirely — `notion_read` / `notion_write` return self-healing validation errors that let the model correct its own payload in one turn.

### Honest worst case

Describing **all 48 operations** costs 27,134 tokens on top of the static 1,005, so 28,139 in total — more than the official server's 17,163. An agent that enumerates the catalog loses this trade outright. The design pays only for what a task touches, while the official server pays its full 17,163 on every connection regardless. Note also this server covers **47 operations (plus one alias) vs. the official 24 endpoints**, with richer per-operation schemas (batch semantics, idempotency), so even per-operation the payloads aren't strictly like-for-like.

## Reproduce

```bash
# From the repo root, with the server built (npm run build):
cd benchmarks
NOTION_TOKEN=ntn_dummy node list-tools.mjs awkoy node ../build/index.js > awkoy.json
OPENAPI_MCP_HEADERS='{"Authorization":"Bearer ntn_dummy","Notion-Version":"2025-09-03"}' \
  node list-tools.mjs notion-official npx -y @notionhq/notion-mcp-server@2.5.2 > official.json
NOTION_TOKEN=ntn_dummy node describe-all.mjs > all-describe.json
python3 count.py     # static footprint, reduction, per-operation spread, session totals
```

`count.py` prints every figure quoted above. It prices the static footprint from the two `*.json` tool listings, and, when `all-describe.json` is present, the on-demand half as well.

Requires `tiktoken` (`pip install tiktoken`).
