# Context-overhead benchmark

An agent pays for a Notion server twice. Once at connection, for the tool surface that sits in context for the whole session. Then again on every call, for the response body, which is appended to the conversation and never leaves it either.

This benchmark measures both halves for **this server** against the **official open-source server** [`@notionhq/notion-mcp-server`](https://www.npmjs.com/package/@notionhq/notion-mcp-server) (one tool per REST endpoint):

- **[The tool surface](#part-1--the-tool-surface)** — what `tools/list` costs before any work happens. 3 tools vs. 24.
- **[The responses](#part-2--the-responses)** — what each answer costs, measured on the same Notion objects through both servers, across pages of graded size.

The second half is the one that compounds: the surface is paid once, responses are paid per call and are unbounded in size.

## Method

1. Drive each server through the MCP stdio handshake and capture its real `tools/list` response (`list-tools.mjs`). No Notion token needed — schema listing is unauthenticated.
2. Serialize each tool into the shape a client forwards to the model's tool-use API (`{name, description, input_schema}`) and count tokens (`count.py`).
3. Tokenizer: `o200k_base` (GPT-4o/4.1) via `tiktoken` — a public, modern proxy for LLM context cost. Anthropic's tokenizer isn't public; absolute counts shift slightly by model, the **ratio** is stable.

For the response half (`output-cost.mjs`, `count-output.py`):

4. Build a fixture of known, graded size (`make-fixture.mjs`) or discover targets from the live workspace, then issue each read as a **matched pair** — the same object, the same page size, through both servers in the same run.
5. Count the tool result the way a host appends it to the conversation: the concatenated text content of `tools/call`, envelope included. Errored pairs are excluded and reported, never silently dropped.
6. Include `get_page` twice, slim and `verbose: true`, as a **control**. Verbose is meant to reproduce the official server's raw shape, so any drift there is measurement error and invalidates the rest.

Raw response bodies stay out of the repo — `/benchmarks/*.json` is gitignored, and `count-output.py` prints aggregates only.

## Part 1 — the tool surface

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

## Part 2 — the responses

Measured 2026-09-21 against a **generated fixture** rather than whatever a workspace happens to contain: five pages of deliberately graded size (3, 13, 35, 88 and 198 blocks of synthetic GFM — headings, prose, bullet and numbered lists, quotes, code blocks, tables) plus a 25-row database with eight property types. `make-fixture.mjs` builds it from a seeded generator, so anyone can recreate the same content and check these numbers.

23 matched pairs, the same objects read through both servers in the same run, tokenized exactly as a host appends them to the conversation.

| Task | n | This server | Official | Delta |
| --- | --- | --- | --- | --- |
| block children | 5 | **12,645** | 71,689 | **82% less** |
| `query_database`, 25 rows | 1 | **3,143** | 16,629 | **81% less** |
| `search_pages` | 1 | **825** | 2,886 | **71% less** |
| `get_page` (slim, our default) | 5 | **564** | 1,790 | **68% less** |
| `list_users` | 1 | **188** | 309 | 39% less |
| page markdown | 5 | 9,096 | 9,267 | 2% — *parity, see below* |
| `get_page` (`verbose: true`) | 5 | 1,787 | 1,787 | — *(control)* |
| **Total** | **23** | **28,248** | **104,357** | **73% less** |

### The control is the point

`verbose: true` makes this server return the raw Notion SDK shape — deliberately the same payload the official server returns. Across all five pages it lands within **4 tokens** of the official figure. That is what makes every other row trustworthy: both servers are demonstrably reading the same objects, so the differences are the slimming and nothing else.

It also sets the honest ceiling. Ask for the raw shape and you pay the raw price; the savings are a default, not a magic property.

### The curve, which is why the fixture exists

A single average hides which rows are structural and which scale with content. Grading the pages by size separates them:

| Page | `get_page` (slim) | page markdown | block children |
| --- | --- | --- | --- |
| XS — 3 blocks | 110 / 356 — **69%** | 124 / 160 — 22% | 208 / 1,023 — **80%** |
| S — 13 blocks | 117 / 359 — **67%** | 341 / 376 — 9% | 753 / 4,088 — **82%** |
| M — 35 blocks | 111 / 353 — **69%** | 925 / 956 — 3% | 1,886 / 10,587 — **82%** |
| L — 88 blocks | 111 / 358 — **69%** | 2,381 / 2,415 — 1% | 4,568 / 26,071 — **82%** |
| XL — 198 blocks | 115 / 364 — **68%** | 5,325 / 5,360 — 1% | 5,230 / 29,920 — **83%** |

Three different shapes, and each means something different:

- **`get_page` is flat.** ~111 tokens against ~357 no matter how big the page is, because a page object does not contain its body. The 69% is pure envelope — the per-property `id`/`type` wrappers, `created_by`, `last_edited_by`, `parent`, `icon`, `cover`. It is the same on a one-line page and a 200-block one, so it transfers to any workspace.
- **Block children holds at 82% and grows in absolute terms.** This is the row that matters: reading a real page's content through the official server costs 26,071 tokens where this server costs 4,568. Notion's block JSON spends most of itself on `annotations`, `plain_text` duplicated beside `rich_text`, and per-block `id`/`created_time`/`last_edited_by`. That ratio is stable across every size tested.
- **Markdown is parity, and we should say so.** Both servers convert the page to markdown, so both return substantially the same bytes; this server's edge is a fixed ~35-token envelope that shrinks to noise on anything real. **This is not a win and earlier versions of this file wrongly claimed one** — the 40% figure published before came from measuring near-empty pages, where a fixed overhead looks like a percentage. On a real page it is 1%.

### Caveats that apply to these numbers

- `get_block_children` was called with `page_size: 100` on both sides, so the XL row covers the first 100 of its 198 blocks — matched, but not a whole page.
- The fixture content is synthetic prose over a realistic block mix. Block *counts* and structure are representative; nobody's actual writing is.
- Two runs, one workspace, one Notion version (`2025-09-03`). The two agreed to within 4 tokens on every row, so run-to-run variance is negligible at this scale — but that is two runs against one workspace, not a claim about all of them.
- `list_users` (39%) is a two-member workspace. It scales with member count and this sample barely tests it.

The headline to carry away is the block-children row and the flat `get_page` row: those are structural, reproducible, and independent of what you happen to have written.

## Reproduce

**Part 1 — the tool surface.** No Notion token needed; schema listing is unauthenticated.

```bash
# From the repo root, with the server built (npm run build):
cd benchmarks
NOTION_TOKEN=ntn_dummy node list-tools.mjs awkoy node ../build/index.js > awkoy.json
OPENAPI_MCP_HEADERS='{"Authorization":"Bearer ntn_dummy","Notion-Version":"2025-09-03"}' \
  node list-tools.mjs notion-official npx -y @notionhq/notion-mcp-server@2.5.2 > official.json
NOTION_TOKEN=ntn_dummy node describe-all.mjs > all-describe.json
python3 count.py     # static footprint, reduction, per-operation spread, session totals
```

**Part 2 — the responses.** Needs a real token, since it reads real objects. `output-cost.mjs` takes it
from the environment and passes it to both servers itself, so it never has to be typed on a command
line; put it in `.env` at the repo root and hand the file to Node.

```bash
# Build the fixture once. It creates one parent page of synthetic content under
# the page you name, and prints the ids the benchmark needs. Delete that page
# when you're done and the whole fixture goes with it.
node --env-file=../.env make-fixture.mjs <parent-page-id> > fixture.json

# Writes raw response bodies — send them somewhere outside the repo.
FIXTURE=fixture.json node --env-file=../.env output-cost.mjs /tmp/output-cost.json
python3 count-output.py /tmp/output-cost.json
```

Without `FIXTURE` the script discovers its own targets by searching the workspace, which measures that
workspace rather than a size curve; `EXCLUDE_PAGES=<id>,<id>` drops pages (and their children) from
that sample. Either way `output-cost.mjs` reads only — nothing is created, updated or archived; the
one script that writes is `make-fixture.mjs`. **The output file contains live page content.**
`count-output.py` prints aggregates only; keep the raw JSON out of version control.

Requires `tiktoken` (`pip install tiktoken`).
