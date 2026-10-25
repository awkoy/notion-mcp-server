export type TransportKind = "stdio" | "http";

export type HttpConfig = {
  transport: TransportKind;
  port: number;
  host: string;
  authToken?: string;
  /** MCP_ALLOW_UNAUTHENTICATED: serve a non-loopback HOST without MCP_AUTH_TOKEN. */
  allowUnauthenticated: boolean;
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

  const allowUnauthenticated = ["true", "1", "yes", "on"].includes(
    (env.MCP_ALLOW_UNAUTHENTICATED ?? "").trim().toLowerCase()
  );

  const allowedHosts = parseList(env.MCP_ALLOWED_HOSTS);
  const allowedOrigins = parseList(env.MCP_ALLOWED_ORIGINS);

  return { transport, port, host, authToken, allowUnauthenticated, allowedHosts, allowedOrigins };
}

/** Bind addresses only this machine can reach: 127.0.0.0/8, ::1 and `localhost`. */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  if (h === "localhost" || h === "::1") return true;
  return /^(::ffff:)?127(\.\d{1,3}){3}$/.test(h);
}

/**
 * Why this config must not start, or null when it may. Whoever reaches /mcp
 * acts as NOTION_TOKEN, so a bind other machines can reach needs
 * MCP_AUTH_TOKEN — unless the operator says, with MCP_ALLOW_UNAUTHENTICATED,
 * that something in front of it (an authenticating proxy, a private network)
 * already does that job.
 */
export function unauthenticatedBindError(config: HttpConfig): string | null {
  if (config.authToken || config.allowUnauthenticated || isLoopbackHost(config.host)) {
    return null;
  }
  return (
    `Refusing to serve HTTP on ${config.host} without MCP_AUTH_TOKEN: anyone who can reach it would act as your NOTION_TOKEN. ` +
    `Set MCP_AUTH_TOKEN, bind HOST=127.0.0.1, or set MCP_ALLOW_UNAUTHENTICATED=true if an authenticating proxy sits in front.`
  );
}
