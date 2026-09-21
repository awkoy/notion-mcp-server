// Builds the benchmark fixture: a page tree of graded sizes plus a database,
// so the response half of the benchmark runs against known content instead of
// whatever a given workspace happens to contain.
//
// Content is synthetic and deterministic (seeded PRNG), so two runs produce the
// same byte sizes and two people produce the same fixture. Everything lands
// under one parent page and nothing outside that subtree is touched.
//
// Usage, from benchmarks/:
//   node --env-file=../.env make-fixture.mjs <parent-page-id>
// Prints the fixture root id, which output-cost.mjs takes as FIXTURE_ROOT.
import { spawn } from "node:child_process";

const PARENT = process.argv[2];
if (!PARENT) {
  console.error("usage: node --env-file=../.env make-fixture.mjs <parent-page-id>");
  process.exit(1);
}
if (!process.env.NOTION_TOKEN) {
  console.error("NOTION_TOKEN is not set (pass --env-file=../.env)");
  process.exit(1);
}

const child = spawn("node", ["../build/index.js"], { env: { ...process.env }, stdio: ["pipe", "pipe", "pipe"] });
let buf = "";
const pending = new Map();
let idc = 0;
child.stdout.on("data", (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  }
});
child.stderr.on("data", () => {});
const rpc = (method, params) => {
  const id = ++idc;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`${method} timed out`)), 120000);
    pending.set(id, (m) => { clearTimeout(t); res(m); });
  });
};
async function call(tool, operation, payload) {
  const r = await rpc("tools/call", { name: tool, arguments: { operation, payload } });
  const text = (r.result?.content ?? []).map((c) => c.text ?? "").join("");
  let j = null;
  try { j = JSON.parse(text); } catch {}
  const data = j?.data ?? j;
  if (r.error || r.result?.isError || j?.ok === false) {
    throw new Error(`${operation} failed: ${text.slice(0, 400)}`);
  }
  return data;
}

// --- deterministic synthetic prose -----------------------------------------
let seed = 20260921;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (a) => a[Math.floor(rnd() * a.length)];

const SUBJ = ["the ingest worker", "the retry queue", "the schema cache", "the rate limiter", "the block shaper", "the auth layer", "the pagination walker", "the batch envelope"];
const VERB = ["drops", "retries", "caches", "validates", "flattens", "rejects", "coalesces", "back-offs on"];
const OBJ = ["malformed rows", "the cursor", "property definitions", "oversized payloads", "duplicate keys", "expired tokens", "partial results", "unknown fields"];
const WHY = ["because the upstream contract changed", "to keep the p99 under budget", "so a partial failure is recoverable", "which is cheaper than re-fetching", "until the window resets", "before it reaches the model"];

const sentence = () => `${pick(SUBJ)} ${pick(VERB)} ${pick(OBJ)} ${pick(WHY)}`.replace(/^./, (c) => c.toUpperCase()) + ".";
const para = (n = 3) => Array.from({ length: n }, sentence).join(" ");

// One "section" is a realistic documentation unit: a heading plus a mix of the
// block types people actually use. Returns markdown. blocksIn() tracks how many
// Notion blocks it becomes, because the API caps children at 100 per request.
function section(i) {
  const kind = i % 5;
  const head = `## ${pick(["Design", "Failure modes", "Rollout", "Open questions", "Measurements", "Runbook", "Constraints"])} ${i + 1}\n\n`;
  if (kind === 0) return head + para(4) + "\n\n" + para(2) + "\n";
  if (kind === 1) return head + para(2) + "\n\n" + Array.from({ length: 5 }, () => `- ${sentence()}`).join("\n") + "\n";
  if (kind === 2) return head + para(2) + "\n\n```ts\n" + `export async function step${i}(input: Payload): Promise<Result> {\n  const parsed = schema.safeParse(input);\n  if (!parsed.success) return fail(parsed.error);\n  return run(parsed.data, { retries: ${i % 4} });\n}\n` + "```\n";
  if (kind === 3) return head + Array.from({ length: 4 }, (_, k) => `${k + 1}. ${sentence()}`).join("\n") + `\n\n> ${sentence()}\n`;
  return head + para(2) + "\n\n| Field | Type | Notes |\n| --- | --- | --- |\n" +
    Array.from({ length: 4 }, (_, k) => `| field_${i}_${k} | ${pick(["string", "number", "boolean", "date"])} | ${pick(OBJ)} |`).join("\n") + "\n";
}
const blocksIn = (i) => [3, 7, 3, 6, 3][i % 5];

// Splits a page into one create plus N appends, each under the block cap, so a
// page can be as long as we want without the fixture depending on a server-side
// chunker that does not exist.
function chunks(sections, cap = 80) {
  const out = [];
  let cur = [], n = 0;
  for (let i = 0; i < sections; i++) {
    if (n + blocksIn(i) > cap && cur.length) { out.push(cur); cur = []; n = 0; }
    cur.push(i); n += blocksIn(i);
  }
  if (cur.length) out.push(cur);
  return out.map((ids) => ids.map(section).join("\n"));
}

// --- build ------------------------------------------------------------------
await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fixture", version: "0" } });
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");

const root = await call("notion_write", "create_page", {
  parent: { type: "page_id", page_id: PARENT },
  title: "MCP benchmark fixture",
  markdown: "Generated by `benchmarks/make-fixture.mjs`. Synthetic content, safe to delete.\n",
});
const rootId = root.id ?? root.page?.id;
console.error(`fixture root: ${rootId}`);

// Graded page sizes. The point is the curve: response cost as a function of
// page size, rather than one average over whatever a workspace holds.
const SIZES = [
  ["XS", 1], ["S", 3], ["M", 8], ["L", 20], ["XL", 45],
];
const pages = [];
for (const [label, sections] of SIZES) {
  const parts = chunks(sections);
  const blocks = Array.from({ length: sections }, (_, i) => blocksIn(i)).reduce((a, b) => a + b, 0);
  const p = await call("notion_write", "create_page", {
    parent: { type: "page_id", page_id: rootId },
    title: `Fixture ${label} — ${sections} section${sections === 1 ? "" : "s"}`,
    markdown: parts[0],
  });
  const pid = p.id ?? p.page?.id;
  for (const part of parts.slice(1)) {
    await call("notion_write", "append_blocks", { block_id: pid, markdown: part });
  }
  const chars = parts.join("\n").length;
  pages.push({ label, sections, blocks, chars, id: pid });
  console.error(`  ${label}: ${sections} sections / ~${blocks} blocks / ${chars} chars -> ${pid}`);
}

// A database with a spread of property types, which is what makes a raw
// `properties` bag expensive.
const db = await call("notion_write", "create_database", {
  parent: { type: "page_id", page_id: rootId },
  title: "Fixture tasks",
  properties: {
    Name: { type: "title", title: {} },
    Status: { type: "select", select: { options: [
      { name: "Backlog", color: "gray" }, { name: "In progress", color: "blue" },
      { name: "Blocked", color: "red" }, { name: "Done", color: "green" }] } },
    Area: { type: "multi_select", multi_select: { options: [
      { name: "ingest", color: "purple" }, { name: "api", color: "yellow" },
      { name: "cache", color: "orange" }, { name: "auth", color: "pink" }] } },
    Estimate: { type: "number", number: { format: "number" } },
    Due: { type: "date", date: {} },
    Done: { type: "checkbox", checkbox: {} },
    Owner: { type: "rich_text", rich_text: {} },
    Spec: { type: "url", url: {} },
  },
});
const dbId = db.id ?? db.database?.id;
const sources = await call("notion_read", "list_data_sources", { database_id: dbId });
const dsId = (sources.data_sources ?? sources.results ?? [])[0]?.id;
console.error(`database: ${dbId} (data source ${dsId})`);

const STATUS = ["Backlog", "In progress", "Blocked", "Done"];
const AREA = ["ingest", "api", "cache", "auth"];
const rows = Array.from({ length: 25 }, (_, i) => ({
  parent: { type: "data_source_id", data_source_id: dsId },
  title: `${pick(["Fix", "Measure", "Harden", "Document", "Refactor"])} ${pick(SUBJ)} (#${i + 1})`,
  properties: {
    Status: STATUS[i % 4],
    Area: [AREA[i % 4], AREA[(i + 2) % 4]],
    Estimate: (i % 7) + 1,
    Due: `2026-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 27) + 1).padStart(2, "0")}`,
    Done: i % 4 === 3,
    Owner: pick(["platform", "agents", "infra", "docs"]),
    Spec: `https://example.invalid/specs/${i + 1}`,
  },
}));
await call("notion_write", "create_page", { items: rows, concurrency: 5 });
console.error(`rows: ${rows.length}`);

console.log(JSON.stringify({ rootId, dbId, dsId, pages }, null, 1));
child.kill();
process.exit(0);
