import { createRequire } from "node:module";

// Read the version straight from package.json so the MCP handshake always
// reports the real published version instead of a hand-maintained constant
// that silently drifts. createRequire resolves relative to this module, which
// is two levels deep in both src/ (src/config/index.ts) and build/.
const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version: string };

// Configuration
export const CONFIG = {
  serverName: "notion-mcp-server",
  serverTitle: "Notion",
  serverVersion: pkg.version,
  serverUrl: "https://github.com/awkoy/notion-mcp-server",
};
