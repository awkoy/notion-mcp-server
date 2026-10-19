export type TransportKind = "stdio" | "http";

// The transport this process is serving. startHttp sets it; stdio is the
// default, as in parseHttpConfig. Read by operations whose safe behaviour
// depends on who can reach them: upload_file refuses local paths over HTTP
// unless NOTION_UPLOAD_ROOT is set, because there the caller is remote.
let activeTransport: TransportKind = "stdio";

export function setActiveTransport(kind: TransportKind): void {
  activeTransport = kind;
}

export function getActiveTransport(): TransportKind {
  return activeTransport;
}

export type HttpConfig = {
  transport: TransportKind;
  port: number;
  host: string;
  authToken?: string;
  allowedHosts: string[];
  allowedOrigins: string[];
};

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = "127.0.0.1";

function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Pure: derive the transport config from environment variables. No I/O.
 *
 *  `allowedHosts`/`allowedOrigins` are returned as the *explicit* env lists only
 *  (empty when unset). The localhost defaults depend on the actually-bound port —
 *  which can differ from `port` when `PORT=0` — so they are filled in by startHttp
 *  after the socket is listening, not here. */
export function parseHttpConfig(env: NodeJS.ProcessEnv): HttpConfig {
  const transport: TransportKind =
    (env.MCP_TRANSPORT ?? "").trim().toLowerCase() === "http" ? "http" : "stdio";

  const portRaw = (env.PORT ?? "").trim();
  const portNum = Number.parseInt(portRaw, 10);
  // 0 is valid — it asks the OS for an ephemeral port. Negatives/NaN -> default.
  const port = Number.isInteger(portNum) && portNum >= 0 ? portNum : DEFAULT_PORT;

  const host = (env.HOST ?? "").trim() || DEFAULT_HOST;

  const authTokenRaw = (env.MCP_AUTH_TOKEN ?? "").trim();
  const authToken = authTokenRaw === "" ? undefined : authTokenRaw;

  const allowedHosts = parseList(env.MCP_ALLOWED_HOSTS);
  const allowedOrigins = parseList(env.MCP_ALLOWED_ORIGINS);

  return { transport, port, host, authToken, allowedHosts, allowedOrigins };
}
