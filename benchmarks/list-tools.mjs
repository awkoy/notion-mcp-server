// Drives an MCP server over stdio through the handshake and captures tools/list.
// Usage: node list-tools.mjs <label> <command> [args...]
import { spawn } from "node:child_process";

const [, , label, cmd, ...args] = process.argv;
const child = spawn(cmd, args, { env: { ...process.env }, stdio: ["pipe", "pipe", "pipe"] });

let buf = "";
const pending = new Map();
let idc = 0;
const rpc = (method, params) => {
  const id = ++idc;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((res) => pending.set(id, res));
};
const notify = (method, params) =>
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");

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

child.stderr.on("data", () => {}); // swallow banner/logs

const fail = (m) => { console.error("ERR:", m); child.kill(); process.exit(1); };
setTimeout(() => fail("timeout"), 60000);

await rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "bench", version: "0.0.0" },
});
notify("notifications/initialized", {});
const res = await rpc("tools/list", {});
const tools = res.result?.tools ?? [];
process.stdout.write(JSON.stringify({ label, count: tools.length, tools }));
child.kill();
process.exit(0);
