import { PROTOCOL_VERSION_META_KEY, type ServerContext } from "@modelcontextprotocol/server";

/**
 * Whether `ctx` belongs to a protocol 2026-07-28 request. That revision has no
 * session: each request carries its own `_meta` envelope, and the SDK lifts
 * it into `ctx.mcpReq.envelope`. It does so on every era, though — a 2025-era
 * client may send reserved `_meta` keys too — so envelope *presence* is not
 * the test. What only a 2026-07-28 request carries is the protocol version
 * key: the SDK requires it to classify a request as modern in the first
 * place. Code that must choose between "per request" and "per connection"
 * (client capabilities, log level) branches on this.
 */
export function isModernRequest(ctx: ServerContext | undefined): boolean {
  const envelope = ctx?.mcpReq.envelope as Record<string, unknown> | undefined;
  return envelope?.[PROTOCOL_VERSION_META_KEY] !== undefined;
}
