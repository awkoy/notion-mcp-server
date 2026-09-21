// Prices the *response* side of the benchmark: what a tool result costs once it
// lands in the conversation. The static tool surface is paid once per session;
// results are paid on every call and are unbounded, so this is the half that
// dominates a long session.
//
// Runs matched read operations against this server and @notionhq/notion-mcp-server
// on the same live Notion objects, and writes every response body out for
// count.py to tokenize. `get_page` is measured twice — slim (our default) and
// verbose (the raw Notion SDK shape) — so the delta can be attributed to
// slimming rather than to the two servers reading different things.
//
// Usage, from benchmarks/ with a real token in ../.env:
//   node --env-file=../.env output-cost.mjs /path/to/out.json
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const OUT = process.argv[2];
if (!OUT) {
  console.error("usage: node --env-file=../.env output-cost.mjs <out.json>");
  process.exit(1);
}
const TOKEN = process.env.NOTION_TOKEN;
if (!TOKEN) {
  console.error("NOTION_TOKEN is not set (pass --env-file=../.env)");
  process.exit(1);
}
const NOTION_VERSION = "2025-09-03";
const PAGE_SIZE = 25;

function client(label, cmd, args, env) {
  const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  let buf = "";
  const pending = new Map();
  let id = 0;
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    }
  });
  child.stderr.on("data", () => {});
  const rpc = (method, params) => {
    const i = ++id;
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n");
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${label}: ${method} timed out`)), 60000);
      pending.set(i, (m) => { clearTimeout(t); resolve(m); });
    });
  };
  return {
    label,
    child,
    rpc,
    async init() {
      await rpc("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "bench", version: "0.0.0" },
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
    },
    // Returns the response exactly as a host would append it to the conversation:
    // the concatenated text content of the tool result, or the error text.
    async call(name, args) {
      const r = await rpc("tools/call", { name, arguments: args });
      if (r.error) return { ok: false, text: JSON.stringify(r.error) };
      const text = (r.result?.content ?? []).map((c) => c.text ?? "").join("");
      return { ok: !r.result?.isError, text };
    },
  };
}

const ours = client("awkoy", "node", ["../build/index.js"], { NOTION_TOKEN: TOKEN });
const official = client("notion-official", "npx", ["-y", "@notionhq/notion-mcp-server@2.5.2"], {
  OPENAPI_MCP_HEADERS: JSON.stringify({ Authorization: `Bearer ${TOKEN}`, "Notion-Version": NOTION_VERSION }),
});
await Promise.all([ours.init(), official.init()]);

const json = (t) => { try { return JSON.parse(t); } catch { return null; } };
// Our results come wrapped in an {ok, data} envelope; unwrap when present.
const body = (t) => { const j = json(t); return j && j.ok !== undefined && j.data !== undefined ? j.data : j; };

// --- targets ---------------------------------------------------------------
// FIXTURE points at the JSON written by make-fixture.mjs: a known set of pages
// of graded size plus a known database. Without it the script falls back to
// whatever the token can see, which measures a workspace rather than a curve.
let pages, databaseId, dataSourceId = null, searchQuery = null;
const fixturePath = process.env.FIXTURE;
if (fixturePath) {
  const f = JSON.parse(readFileSync(fixturePath, "utf8"));
  pages = f.pages.map((p) => ({ id: p.id, label: `${p.label} (${p.blocks} blocks)` }));
  databaseId = f.dbId;
  dataSourceId = f.dsId;
  searchQuery = process.env.SEARCH_QUERY ?? "Fixture";
  console.error(`fixture: ${pages.length} pages, database ${databaseId ? "yes" : "no"}`);
} else {
  const found = await ours.call("notion_read", { operation: "search_pages", payload: { paginate: true, page_size: 100 } });
  const hits = body(found.text)?.results ?? [];
  // EXCLUDE_PAGES drops a page and its children from the sample. Benchmarks run
  // against a workspace that has also been used for testing will otherwise
  // measure their own scratch objects, which are not representative of anything.
  const norm = (v) => String(v ?? "").replace(/-/g, "");
  const excluded = new Set((process.env.EXCLUDE_PAGES ?? "").split(",").map((x) => norm(x.trim())).filter(Boolean));
  const isExcluded = (h) => excluded.has(norm(h.id)) || excluded.has(norm(h.parent?.page_id)) || excluded.has(norm(h.parent?.id));
  const allPages = hits.filter((h) => h.object === "page");
  const kept = allPages.filter((h) => !isExcluded(h));
  if (excluded.size) console.error(`excluded ${allPages.length - kept.length} of ${allPages.length} pages`);
  pages = kept.slice(0, Number(process.env.MAX_PAGES ?? 8)).map((p, i) => ({ id: p.id, label: `page ${i + 1}` }));
  const databases = hits.filter((h) => h.object === "database" || h.object === "data_source").slice(0, 3);
  console.error(`discovered ${pages.length} pages, ${databases.length} databases`);
  // The official server queries a data source, ours resolves one from the
  // database. Resolve it once here so both sides read the same rows.
  for (const d of databases) {
    if (d.object === "data_source") {
      // search already handed back a data source: its parent is the database.
      dataSourceId = d.id;
      databaseId = d.parent?.database_id ?? d.parent?.id ?? null;
      if (databaseId) break;
      dataSourceId = null;
      continue;
    }
    const ds = await ours.call("notion_read", { operation: "list_data_sources", payload: { database_id: d.id } });
    const d2 = body(ds.text);
    const first = d2?.data_sources?.[0]?.id ?? d2?.results?.[0]?.id;
    if (first) { dataSourceId = first; databaseId = d.id; break; }
  }
  console.error(`database target: ${databaseId ? "resolved" : "none"}`);
}
if (!pages.length) {
  console.error("no pages to measure");
  process.exit(1);
}

// --- matched tasks ---------------------------------------------------------
const tasks = [];
const searchArgs = searchQuery ? { query: searchQuery, page_size: PAGE_SIZE } : { page_size: PAGE_SIZE };
tasks.push({
  task: "search",
  target: searchQuery ? `query "${searchQuery}"` : "workspace",
  ours: ["notion_read", { operation: "search_pages", payload: searchArgs }],
  official: ["API-post-search", searchArgs],
});
for (const p of pages) {
  const t = p.label;
  tasks.push({
    task: "get_page (slim)",
    target: t,
    ours: ["notion_read", { operation: "get_page", payload: { page_id: p.id } }],
    official: ["API-retrieve-a-page", { page_id: p.id }],
  });
  tasks.push({
    task: "get_page (verbose)",
    target: t,
    ours: ["notion_read", { operation: "get_page", payload: { page_id: p.id, verbose: true } }],
    official: ["API-retrieve-a-page", { page_id: p.id }],
  });
  tasks.push({
    task: "page markdown",
    target: t,
    ours: ["notion_read", { operation: "get_page_markdown", payload: { page_id: p.id } }],
    official: ["API-retrieve-page-markdown", { page_id: p.id }],
  });
  tasks.push({
    task: "block children",
    target: t,
    ours: ["notion_read", { operation: "get_block_children", payload: { block_id: p.id, page_size: 100 } }],
    official: ["API-get-block-children", { block_id: p.id, page_size: 100 }],
  });
}
if (dataSourceId) {
  tasks.push({
    task: `query_database (page_size ${PAGE_SIZE})`,
    target: "database 1",
    ours: ["notion_read", { operation: "query_database", payload: { database_id: databaseId, page_size: PAGE_SIZE } }],
    official: ["API-query-data-source", { data_source_id: dataSourceId, page_size: PAGE_SIZE }],
  });
}
tasks.push({
  task: "list_users",
  target: "workspace",
  ours: ["notion_read", { operation: "list_users", payload: { page_size: 100 } }],
  official: ["API-get-users", { page_size: 100 }],
});

// --- run -------------------------------------------------------------------
const rows = [];
for (const t of tasks) {
  const a = await ours.call(t.ours[0], t.ours[1]);
  const b = await official.call(t.official[0], t.official[1]);
  rows.push({
    task: t.task,
    target: t.target,
    ours: { ok: a.ok, text: a.text },
    official: { ok: b.ok, text: b.text },
  });
  process.stderr.write(`${t.task} / ${t.target}: ours ${a.text.length}c ${a.ok ? "ok" : "ERR"}, official ${b.text.length}c ${b.ok ? "ok" : "ERR"}\n`);
}

writeFileSync(OUT, JSON.stringify({ notionVersion: NOTION_VERSION, pageSize: PAGE_SIZE, rows }, null, 1));
console.error(`\nwrote ${rows.length} matched pairs to ${OUT}`);
ours.child.kill();
official.child.kill();
process.exit(0);
