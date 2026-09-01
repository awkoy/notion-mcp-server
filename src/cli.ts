import { CONFIG } from "./config/index.js";

/**
 * What the command line asked for. `run` is the normal case — start a
 * transport. The other three print something and stop before anything is
 * initialised, so `--version` in a CI step or a health script never opens a
 * socket or reads NOTION_TOKEN.
 */
export type CliAction =
  | { kind: "run" }
  | { kind: "version" }
  | { kind: "help" }
  | { kind: "unknown"; option: string };

export type CliReply = {
  text: string;
  stream: "stdout" | "stderr";
  exitCode: number;
};

/**
 * The server is configured entirely through environment variables; the only
 * arguments it takes are informational, so the first one decides and there is
 * nothing to combine. Anything else — a typo, a stray positional — is an
 * unknown option rather than something to ignore, because a server that
 * silently starts on stdin after `--verison` is worse than one that says no.
 */
export function parseCliArgs(argv: readonly string[]): CliAction {
  const first = argv[0];
  if (first === undefined) return { kind: "run" };
  if (first === "--version" || first === "-v") return { kind: "version" };
  if (first === "--help" || first === "-h") return { kind: "help" };
  return { kind: "unknown", option: first };
}

/** The package version and a newline, nothing else — meant to be captured. */
export function versionText(): string {
  return `${CONFIG.serverVersion}\n`;
}

const REPO = CONFIG.serverUrl;

/**
 * One line per environment variable, kept in step with the README tables by
 * tests/cli.test.ts (every variable in the README must appear here).
 */
export function usageText(): string {
  return `Usage: notion-mcp-server [--version | --help]

Notion MCP server for Claude, Cursor, VS Code and any other MCP client.
Everything is configured through environment variables; the only command-line
options are the two above.

Transports:
  stdio (default)   MCP over stdin/stdout — what \`claude mcp add\`, Cursor and
                    Claude Desktop use.
  http              Set MCP_TRANSPORT=http to serve Streamable HTTP at /mcp
                    (plus an unauthenticated GET /health).

Environment:
  NOTION_TOKEN               required — PAT (ntn_...) or Internal Integration secret
  NOTION_PAGE_ID             default parent for create_page / create_database (URL or id)
  NOTION_RATE_LIMIT          requests per second for the shared limiter (default 3)
  NOTION_READ_ONLY           true/1/yes disables every write operation
  NOTION_ALLOWED_OPERATIONS  comma-separated allowlist of operations or group presets
  NOTION_BLOCKED_OPERATIONS  comma-separated blocklist (same vocabulary); wins over the allowlist
  NOTION_CONFIRM_DESTRUCTIVE true/1 asks you to confirm each destructive operation (MCP elicitation)
  NOTION_UPLOAD_ROOT         confine upload_file's path source to one directory
  NOTION_FILE_URLS           "ref" swaps signed file URLs for short notion-file: refs (default full)
  HTTPS_PROXY / HTTP_PROXY   route all outbound traffic through an HTTP(S) proxy (lowercase works too)
  NOTION_DAILY_LOG_PAGE_ID   only used by the daily-log MCP prompt
  MCP_TRANSPORT              stdio (default) or http
  PORT                       HTTP listen port (default 3000; 0 = OS-assigned)
  HOST                       HTTP bind address (default 127.0.0.1; 0.0.0.0 only with MCP_AUTH_TOKEN)
  MCP_AUTH_TOKEN             HTTP: require "Authorization: Bearer <token>" on /mcp
  MCP_ALLOWED_HOSTS          HTTP: comma-list for the DNS-rebinding Host allowlist
  MCP_ALLOWED_ORIGINS        HTTP: comma-list for the browser Origin allowlist

Docs:
  README          ${REPO}#readme
  Configuration   ${REPO}#-configuration
  HTTP transport  ${REPO}#-remote--http-transport
  Changelog       ${REPO}/blob/main/CHANGELOG.md
`;
}

/** What to print, where, and the exit status — pure, so it can be tested without spawning. */
export function cliReply(action: Exclude<CliAction, { kind: "run" }>): CliReply {
  switch (action.kind) {
    case "version":
      return { text: versionText(), stream: "stdout", exitCode: 0 };
    case "help":
      return { text: usageText(), stream: "stdout", exitCode: 0 };
    case "unknown":
      return {
        text: `Unknown option: ${action.option}\n\n${usageText()}`,
        stream: "stderr",
        exitCode: 2,
      };
  }
}
