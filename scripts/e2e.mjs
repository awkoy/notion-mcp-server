// Live end-to-end smoke test: starts build/index.js over stdio and drives every
// operation against a real Notion workspace. Not part of `npm test` — it needs
// a token and touches a workspace.
//
//   npm run build
//   npm run e2e            # read-only: every read operation, resources, prompts
//   npm run e2e -- --write # also every write operation, inside one page created
//                          # under NOTION_PAGE_ID and trashed at the end
//   npm run e2e -- --write --keep   # leave the test page for inspection
//
// `npm run e2e` loads NOTION_TOKEN and NOTION_PAGE_ID from ./.env (gitignored);
// or run `node --env-file=<file> scripts/e2e.mjs` with any env file.
// Exit code 1 when any check fails. Output is a PASS/FAIL table per check plus
// the list of operations the run did not reach.
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("../build/index.js", import.meta.url));
const WRITE = process.argv.includes("--write");
const KEEP = process.argv.includes("--keep");
const ROOT = process.env.NOTION_PAGE_ID;
if (!process.env.NOTION_TOKEN) { console.error("NOTION_TOKEN missing"); process.exit(2); }
if (WRITE && !ROOT) { console.error("NOTION_PAGE_ID required for --write"); process.exit(2); }

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [SERVER],
  env: { ...process.env, NOTION_FILE_URLS: "ref" },
  stderr: "pipe",
});
transport.stderr?.on("data", (d) => process.stderr.write("[server] " + d));
const client = new Client({ name: "e2e-smoke", version: "0.0.0" });
await client.connect(transport);

const results = [];
const exercised = new Set();
const find = (o, key) => {
  if (!o || typeof o !== "object") return undefined;
  if (key in o && (typeof o[key] === "string")) return o[key];
  for (const v of Object.values(o)) { const r = find(v, key); if (r !== undefined) return r; }
};
function record(op, ok, ms, note) { results.push({ op, ok, ms, note: String(note ?? "").replace(/\s+/g, " ").slice(0, 220) }); }

// notion_read runs read operations, notion_write write operations; the
// notion://operations table (read below) says which is which.
const toolByOp = new Map();
const toolFor = (op) => toolByOp.get(op) ?? "notion_write";

async function exec(op, payload, label = op) {
  exercised.add(op);
  const t0 = Date.now();
  let res;
  try { res = await client.callTool({ name: toolFor(op), arguments: { operation: op, payload } }); }
  catch (e) { record(label, false, Date.now() - t0, "transport: " + e.message); return null; }
  const text = res.content?.find((c) => c.type === "text")?.text;
  const image = res.content?.find((c) => c.type === "image");
  let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch {}
  const ok = !res.isError && (!!image || parsed?.ok !== false);
  if (image) { record(label, ok, Date.now() - t0, `image ${image.mimeType}, ${image.data.length} b64 chars`); return image; }
  const note = ok ? JSON.stringify(parsed?.data ?? parsed) : (parsed?.error ? `${parsed.error.code}: ${parsed.error.message} | fix: ${parsed.error.fix ?? ""}` : text);
  record(label, ok, Date.now() - t0, note);
  return ok ? (parsed?.data ?? parsed) : null;
}
async function expectError(op, payload, label) {
  exercised.add(op);
  const t0 = Date.now();
  const res = await client.callTool({ name: toolFor(op), arguments: { operation: op, payload } });
  const text = res.content?.find((c) => c.type === "text")?.text ?? "";
  let parsed = null; try { parsed = JSON.parse(text); } catch {}
  const hasSchema = /schema/i.test(text) && /example/i.test(text);
  record(label, !!res.isError && hasSchema, Date.now() - t0, `isError=${res.isError} code=${parsed?.error?.code} schema+example=${hasSchema} (${text.length} chars)`);
}

// ---- protocol surface -------------------------------------------------------
const tools = await client.listTools();
const resources = await client.listResources();
const templates = await client.listResourceTemplates();
const prompts = await client.listPrompts();
record("mcp: tools/resources/templates/prompts", tools.tools.length === 3 && resources.resources.length === 1 && templates.resourceTemplates.length === 2 && prompts.prompts.length === 4, 0,
  `${tools.tools.map((t) => t.name).join(",")} | ${resources.resources.length} res, ${templates.resourceTemplates.length} templates, ${prompts.prompts.length} prompts`);
const opsIndex = await client.readResource({ uri: "notion://operations" });
const opsText = opsIndex.contents[0]?.text ?? "";
const allOps = [...opsText.matchAll(/^\| `(\w+)` \| (notion_\w+) \|/gm)].map((m) => (toolByOp.set(m[1], m[2]), m[1]));
record("resource notion://operations", allOps.length > 0, 0, `${allOps.length} operations listed (${[...toolByOp.values()].filter((t) => t === "notion_read").length} read)`);
for (const p of prompts.prompts) {
  const args = Object.fromEntries((p.arguments ?? []).filter((a) => a.required).map((a) => [a.name, ROOT ?? "test"]));
  try { const g = await client.getPrompt({ name: p.name, arguments: args }); record(`prompt ${p.name}`, g.messages.length > 0, 0, `${g.messages.length} messages`); }
  catch (e) { record(`prompt ${p.name}`, false, 0, e.message); }
}
let describedOk = 0;
for (const op of allOps) {
  const d = await client.callTool({ name: "notion_describe", arguments: { operation: op } });
  const txt = d.content?.[0]?.text ?? "";
  if (!d.isError && txt.includes('"schema"') && txt.includes('"example"')) describedOk++;
}
record("notion_describe × all", describedOk === allOps.length, 0, `${describedOk}/${allOps.length} return schema + example`);
await expectError("set_page_title", {}, "error carries schema+example (set_page_title {})");

// ---- read phase --------------------------------------------------------------
const me = await exec("get_self", {});
await exec("get_bot_user", {});
const users = await exec("list_users", { page_size: 10 });
const userId = find(users, "id") ?? find(me, "id");
if (userId) await exec("get_user", { user_id: userId });
let search = await exec("search_pages", { page_size: 5 });
if (!search) search = await exec("search_pages", { query: "a", page_size: 5 }, "search_pages (query)");
const somePage = ROOT ?? find(search, "id");
if (somePage) {
  await exec("get_page", { page_id: somePage });
  await exec("get_page", { page_id: somePage, include_properties: true, verbose: true }, "get_page (verbose)");
  await exec("get_page_markdown", { page_id: somePage });
  const kids = await exec("get_block_children", { block_id: somePage, page_size: 20 });
  const kid = find(kids, "id");
  if (kid) await exec("get_block", { block_id: kid });
  await exec("list_comments", { block_id: somePage });
  const page = await client.readResource({ uri: `notion://page/${somePage}` }).catch((e) => ({ error: e.message }));
  record("resource notion://page/{id}", !!page.contents, 0, page.contents ? `${page.contents[0].text.length} chars markdown` : page.error);
  const undashed = somePage.replace(/-/g, "");
  await exec("get_page", { page_id: `https://www.notion.so/E2E-${undashed}` }, "get_page (Notion URL as id)");
}
await exec("list_file_uploads", { status: "uploaded", page_size: 5 });

// ---- write phase ---------------------------------------------------------------
let P = null;
if (WRITE) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const created = await exec("create_page", { parent: { type: "page_id", page_id: ROOT }, title: `e2e smoke ${ts}`, markdown: "## Hello\n\nFirst paragraph." });
  P = find(created, "id");
  if (!P) { console.error("create_page failed; skipping the rest of the write phase"); }
  else {
    await exec("set_page_title", { page_id: P, title: `e2e smoke ${ts} (renamed)` });
    await exec("set_page_title", { items: [{ page_id: P, title: `e2e smoke ${ts} (batch)` }], atomic: false }, "set_page_title (batch mode)");
    await exec("append_blocks", { block_id: P, markdown: "## Section\n\n- bullet 1\n- bullet 2\n\nParagraph to update." });
    let kids = await exec("get_block_children", { block_id: P, page_size: 50 }, "get_block_children (after append)");
    const blocks = (kids?.results ?? kids?.blocks ?? (Array.isArray(kids) ? kids : [])) ;
    const lastBlock = blocks.length ? find(blocks[blocks.length - 1], "id") : find(kids, "id");
    if (lastBlock) await exec("update_block", { block_id: lastBlock, markdown: "Updated paragraph text." });
    await exec("batch_mixed_blocks", { operations: [{ op: "append", block_id: P, markdown: "Appended by batch_mixed_blocks\n" }] });
    kids = await exec("get_block_children", { block_id: P, page_size: 50 }, "get_block_children (before delete)");
    const blocks2 = (kids?.results ?? kids?.blocks ?? (Array.isArray(kids) ? kids : []));
    const victim = blocks2.length ? find(blocks2[blocks2.length - 1], "id") : null;
    if (victim) await exec("delete_block", { block_id: victim });
    await exec("update_page_markdown", { page_id: P, markdown: "## Replaced heading\n\nReplaced body.", allow_deleting_content: true });
    const md = await exec("get_page_markdown", { page_id: P }, "get_page_markdown (after replace)");
    record("markdown round-trip contains 'Replaced'", JSON.stringify(md ?? "").includes("Replaced"), 0, "");

    // database + data source + views
    const db = await exec("create_database", { parent: { type: "page_id", page_id: P }, title: "e2e db", properties: {
      Name: { type: "title", title: {} },
      Status: { type: "select", select: { options: [{ name: "Open", color: "blue" }, { name: "Done", color: "green" }] } },
      Score: { type: "number", number: { format: "number" } },
      Done: { type: "checkbox", checkbox: {} },
    } });
    const D = find(db, "id");
    if (D) {
      const dss = await exec("list_data_sources", { database_id: D });
      const DS = find(dss, "id") ?? find(db, "data_source_id");
      await exec("get_data_source", { data_source_id: DS });
      await exec("update_data_source", { data_source_id: DS, properties: { Priority: { type: "select", select: { options: [{ name: "High", color: "red" }] } } } }, "update_data_source (add property)");
      await exec("update_data_source", { data_source_id: DS, properties: { Priority: null } }, "update_data_source (null deletes property)");
      await exec("update_database", { database_id: D, title: "e2e db (renamed)" });
      await exec("list_data_source_templates", { data_source_id: DS });
      const row = await exec("create_page", { parent: { type: "data_source_id", data_source_id: DS }, title: "row 1" }, "create_page (in data source)");
      const R = find(row, "id");
      if (R) {
        await exec("set_page_property", { page_id: R, name: "Status", value: { select: { name: "Open" } } });
        await exec("set_page_properties", { page_id: R, properties: { Score: { number: 42 }, Done: { checkbox: true } } });
      }
      await exec("query_database", { database_id: D, where: { Status: "Open" }, page_size: 10 });
      await exec("query_database", { data_source_id: DS, page_size: 10 }, "query_database (by data_source_id)");
      const dbRes = await client.readResource({ uri: `notion://database/${DS}` }).catch((e) => ({ error: e.message }));
      record("resource notion://database/{id}", !!dbRes.contents, 0, dbRes.contents ? `${dbRes.contents[0].text.length} chars` : dbRes.error);
      const view = await exec("create_view", { data_source_id: DS, name: "Open rows", type: "table", where: { Status: "Open" } });
      const V = find(view, "id");
      await exec("list_views", { database_id: D });
      if (V) {
        await exec("get_view", { view_id: V });
        await exec("query_view", { view_id: V, page_size: 10 });
        await exec("update_view", { view_id: V, name: "Open rows (renamed)" });
        await exec("delete_view", { view_id: V });
      }
      await exec("delete_data_source", { data_source_id: DS });
      await exec("delete_data_source", { data_source_id: DS, in_trash: false }, "delete_data_source (restore)");
      await exec("delete_database", { database_id: D });
      await exec("delete_database", { database_id: D, in_trash: false }, "delete_database (restore)");
    }

    // comments
    const c = await exec("add_page_comment", { page_id: P, text: "e2e comment" });
    const C = find(c, "id"); const DISC = find(c, "discussion_id");
    await exec("list_comments", { block_id: P }, "list_comments (after add)");
    if (C) { await exec("get_comment", { comment_id: C }); await exec("update_comment", { comment_id: C, markdown: "e2e comment (edited)" }); }
    if (DISC) await exec("add_discussion_comment", { discussion_id: DISC, text: "e2e reply" });
    if (C) await exec("delete_comment", { comment_id: C });

    // files
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const up = await exec("upload_file", { filename: "e2e.png", content_type: "image/png", source: { type: "base64", data: png }, attach_to: { block_id: P, caption: "e2e image" } });
    const F = find(up, "file_upload_id"); const IB = find(up, "block_id");
    if (F) await exec("get_file_upload", { file_upload_id: F });
    if (IB) {
      await exec("get_block", { block_id: IB }, "get_block (image, NOTION_FILE_URLS=ref)");
      await exec("get_file_url", { ref: `notion-file:block/${IB}` });
      await exec("get_image", { ref: `notion-file:block/${IB}` });
    }

    // page lifecycle
    const sub = await exec("create_page", { parent: { type: "page_id", page_id: P }, title: "e2e subpage" }, "create_page (subpage)");
    const P2 = find(sub, "id");
    if (P2) {
      await exec("move_page", { page_id: P2, parent: { type: "page_id", page_id: ROOT } });
      await exec("move_page", { page_id: P2, parent: { type: "page_id", page_id: P } }, "move_page (back)");
      await exec("archive_page", { page_id: P2 });
      await exec("restore_page", { page_id: P2 });
      await exec("trash_page", { page_id: P2 });
      await exec("restore_page", { page_id: P2 }, "restore_page (after trash)");
    }
  }
}

// ---- report ------------------------------------------------------------------------
try {
  if (P && !KEEP) await exec("trash_page", { page_id: P }, "cleanup: trash test page");
} finally {
  await client.close();
}
const pad = (s, n) => String(s).padEnd(n);
console.log("\n" + pad("op", 46) + pad("ok", 6) + pad("ms", 7) + "note");
for (const r of results) console.log(pad(r.op, 46) + pad(r.ok ? "PASS" : "FAIL", 6) + pad(r.ms, 7) + r.note);
const fails = results.filter((r) => !r.ok);
const missed = allOps.filter((o) => !exercised.has(o));
console.log(`\n${results.length - fails.length}/${results.length} checks passed; ${exercised.size}/${allOps.length} operations exercised`);
if (missed.length) console.log("not exercised: " + missed.join(", "));
if (P) console.log(`test page: ${P}${KEEP ? " (kept)" : " (trashed)"}`);
process.exit(fails.length ? 1 : 0);
