#!/usr/bin/env node
// Builds the Claude Desktop extension bundle (.mcpb).
//
// Stages a minimal package (manifest + compiled server + production deps)
// under mcpb/stage/ and packs it with @anthropic-ai/mcpb. Output lands in
// dist/notion-mcp-server.mcpb.
//
// Prerequisites: `npm run build` has produced build/.

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = path.join(root, "mcpb", "stage");
const dist = path.join(root, "dist");

const run = (cmd, cwd = root) => execSync(cmd, { cwd, stdio: "inherit" });

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
if (!fs.existsSync(path.join(root, "build", "index.js"))) {
  console.error("build/index.js missing — run `npm run build` first.");
  process.exit(1);
}

fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
fs.mkdirSync(dist, { recursive: true });

const manifest = JSON.parse(
  fs.readFileSync(path.join(root, "mcpb", "manifest.json"), "utf8")
);
manifest.version = pkg.version;
fs.writeFileSync(
  path.join(stage, "manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n"
);

fs.cpSync(path.join(root, "build"), path.join(stage, "build"), {
  recursive: true,
});
for (const f of ["package.json", "package-lock.json", "LICENSE"]) {
  fs.copyFileSync(path.join(root, f), path.join(stage, f));
}

// Production deps only; --ignore-scripts for the same supply-chain reasons
// as publish-npm.yml (no runtime dep needs a lifecycle script).
run("npm install --omit=dev --ignore-scripts --no-audit --no-fund", stage);

run(`npx -y @anthropic-ai/mcpb validate ${path.join(stage, "manifest.json")}`);
run(
  `npx -y @anthropic-ai/mcpb pack ${stage} ${path.join(dist, "notion-mcp-server.mcpb")}`
);

console.log(`\nPacked dist/notion-mcp-server.mcpb (v${pkg.version})`);
