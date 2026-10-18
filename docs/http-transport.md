# HTTP transport and protocol versions

The [README](../README.md#remote--http-transport) has the command, the environment variables and the security warning. This page covers what the endpoint serves, how to run it in a container, and which MCP protocol revisions it speaks.

## What `/mcp` serves

`MCP_TRANSPORT=http` serves MCP **Streamable HTTP** on `/mcp`, plus an unauthenticated `GET /health`. The process is single-tenant: every request acts as the one `NOTION_TOKEN` the process started with.

Both current protocol generations are served, picked per request from what the client sends:

| Client speaks | What it gets |
| --- | --- |
| **MCP 2026-07-28** | The stateless path. Every `POST` stands alone: no session, `server/discover`, cache hints on every list. |
| **2024-11-05 … 2025-11-25** | Sessions via the `mcp-session-id` header, plus the `GET` stream and `DELETE`. A `GET` or `DELETE` without a session id is answered 405. |

Checking it locally:

```bash
curl http://127.0.0.1:3000/health
# -> {"status":"healthy","transport":"http","port":3000}
npx @modelcontextprotocol/inspector --transport http --server-url http://127.0.0.1:3000/mcp
```

## Docker

Inside a container `127.0.0.1` is the container's own loopback, so `HOST=0.0.0.0` is what makes the published port reachable. A non-loopback bind is exactly where `MCP_AUTH_TOKEN` is needed:

```bash
docker run --rm -e NOTION_TOKEN=ntn_xxx -e MCP_TRANSPORT=http -e HOST=0.0.0.0 -e MCP_AUTH_TOKEN=change-me \
  -p 3000:3000 ghcr.io/awkoy/notion-mcp-server
```

The image is OCI-compliant, so Podman, OrbStack, colima, Rancher Desktop, Finch and nerdctl take the same flags.

### Health checks

The image ships without a `HEALTHCHECK` because it starts in stdio mode, where nothing listens and a built-in probe of `/health` would mark every stdio container unhealthy. Add one yourself for an HTTP deployment. The same command sits commented out in the `Dockerfile`, and works as `--health-cmd` on `docker run` too:

```yaml
services:
  notion-mcp-server:
    image: ghcr.io/awkoy/notion-mcp-server:latest
    environment:
      NOTION_TOKEN: ${NOTION_TOKEN:?NOTION_TOKEN is required}
      MCP_TRANSPORT: http
      HOST: 0.0.0.0
      MCP_AUTH_TOKEN: ${MCP_AUTH_TOKEN:?MCP_AUTH_TOKEN is required}
    ports: ["3000:3000"]
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 3s
      start_period: 5s
      retries: 3
```

## Protocol versions

The server speaks MCP 2024-11-05 through 2026-07-28 on both transports.

- **Claude Code over stdio** speaks the 2025-era protocol unless told otherwise. Set `MCP_PROTOCOL_NEGOTIATION=auto` in its environment and it probes for MCP 2026-07-28 (stateless requests, cache hints on every list).
- **Claude Desktop builds affected by [anthropics/claude-code#93290](https://github.com/anthropics/claude-code/issues/93290)** send a 2026-07-28 body under an `MCP-Protocol-Version: 2025-11-25` header. The server realigns that one known mismatch so those builds work. Every other disagreement between header and body gets the rejection the spec prescribes (`-32020`).
- **Confirmations and logs** work differently on 2026-07-28 clients. See [confirming destructive operations](./configuration.md#confirming-destructive-operations) and [logs](./configuration.md#logs).
