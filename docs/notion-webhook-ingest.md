# Notion webhook ingestion on the existing MCP listener

This implementation is deliberately disabled unless the managed SanityCloud
launcher sets NOTION_WEBHOOK_CONFIG_JSON. It adds **no new server**, scheduler,
agent manager, credential store, Notion profile or producer of Notion API writes.
The existing HTTP listener serves POST /webhooks/notion/<opaque-route> as well
as /mcp and /health. Never expose /mcp to unauthenticated internet callers.

## Per-subscription configuration contract

NOTION_WEBHOOK_CONFIG_JSON is a JSON object with an absolute ledgerPath and
nonempty bindings. Every binding must contain a unique opaque route (24-96
characters, letters/numbers/underscore/hyphen), subscriptionId, integrationId,
workspaceId, accountId and apiVersion (e.g., 2026-03-11). The accountId must
be the exact existing SanityCloud Notion account mapping owned by the runner.
The same subscriptionId cannot be bound twice. A binding also contains a
verificationToken held in the managed secret system; never print its value,
or, during initial subscription setup only, an absolute bootstrapFile.

Keep this config in a protected runner setting, not in source or Notion.
Do not reuse one subscription's token in a different workspace or account.

## Two-stage Notion subscription activation

1. Provision a new public HTTPS endpoint through the existing authorized
   Cloudflare route specifically for POST /webhooks/notion/<opaque-route>.
   Configure the managed runner with bootstrapFile and no verificationToken.
2. Create the matching Notion subscription. Its unsigned one-time verification
   challenge is written atomically to bootstrapFile with restrictive permissions.
   The response contains no token. Enter the value manually in Notion's
   verification UI without copying it into Notion documents, chat or logs.
3. Transfer the verified token into the existing Bitwarden-managed service
   secret mechanism. Replace the bootstrap binding with verificationToken,
   keep the same subscription/account/workspace/API version, and restart only
   through the controlled existing NotionAwkoy release workflow.
4. Enable page.created, page.properties_updated and page.permissions_updated
   on that exact subscription. Test the public route without changing the
   installed Notion 3021 package before release cutover.

## Processing and trust boundary

All signed events are validated with an HMAC over the original raw bytes
before JSON parsing. Unknown routes, wrong workspace/integration/subscription,
wrong API version and unsupported event types are rejected. Accepted events
are appended to the existing listener's local append-only ledger and fsynced
before HTTP 202. Duplicate IDs for a subscription return 200 even after
process restart; corrupt/partial ledger state blocks startup.

The ledger contains only event metadata, the existing bound account ID and
state pending_refetch. Event IDs and timestamps are evidence, not an
automatic action authorization. No embedded payload content is trusted to
represent the latest page state. In particular, page.permissions_updated
does NOT report the precise sharing change or current public_url.

**Deliberately not implemented:** automatic downstream processing of this
ledger. A separate authorized existing SanityCloud consumer must retrieve
the page under exactly the binding's account identity, reconcile current
page state and persist a separate result receipt before any actions. If
the page is inaccessible or public_url is null, treat that as unknown or
nonpublic based on current API readback; do not infer from the webhook.
This consumer and end-to-end public HTTPS subscription QA are required
before production activation. No new orchestrator is permitted.

## Limits and rollback

Max request body 256 KiB; ledger 50,000 event identities or 32 MiB at startup.
The design is single-writer per managed listener; do not point two separate
processes at the same ledger, and never replay an unknown acknowledgment
outcome. Configure supervised encrypted backups, ledger rotation/reconciliation,
and rollback of the exact installed runtime and all nine SanityCloud overlays.
Preserve the four existing account profiles, blocked operations, current
idempotency ledger, Quick Filters and their prior live readback. Neither
Custom Agent nor meeting-note expansion is in scope.

Sources:
- https://developers.notion.com/reference/webhooks
- https://developers.notion.com/reference/webhooks-events-delivery
