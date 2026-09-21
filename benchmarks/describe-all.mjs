// Costs one `notion_describe` call per operation, so the on-demand half of the
// benchmark can be priced. The operation list is read from the server's own
// tool enums rather than hardcoded: a hardcoded copy silently goes stale every
// time an operation is added, and then the "describe everything" worst case is
// measured against a catalog that no longer exists.
// Usage: NOTION_TOKEN=ntn_dummy node describe-all.mjs > all-describe.json
import { spawn } from "node:child_process";

const child = spawn("node", ["../build/index.js"], {
  env: { ...process.env, NOTION_TOKEN: process.env.NOTION_TOKEN || "ntn_dummy" },
  stdio: ["pipe", "pipe", "pipe"],
});
let buf = "";
const pending = new Map();
let id = 0;
const rpc = (m, p) => {
  const i = ++id;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method: m, params: p }) + "\n");
  return new Promise((r) => pending.set(i, r));
};
const notify = (m, p) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: m, params: p }) + "\n");
child.stdout.on("data", (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const l = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!l) continue;
    let m;
    try { m = JSON.parse(l); } catch { continue; }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  }
});
child.stderr.on("data", () => {});

await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "b", version: "0" } });
notify("notifications/initialized", {});

const listed = await rpc("tools/list", {});
const OPS = [
  ...new Set(
    (listed.result?.tools ?? []).flatMap((t) => t.inputSchema?.properties?.operation?.enum ?? []),
  ),
].sort();
if (!OPS.length) {
  console.error("no operation enums found in tools/list");
  process.exit(1);
}

const out = {};
for (const op of OPS) {
  const r = await rpc("tools/call", { name: "notion_describe", arguments: { operation: op } });
  out[op] = (r.result?.content || []).map((c) => c.text || "").join("");
}
child.kill();
process.stdout.write(JSON.stringify(out));
process.exit(0);
