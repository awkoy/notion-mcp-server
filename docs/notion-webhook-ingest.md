# Notion webhook ingestion on the existing MCP listener

This optional implementation is disabled unless its owner-managed launcher
sets NOTION_WEBHOOK_CONFIG_JSON. It adds **no new server**, scheduler,
agent manager, credential store, Notion profile or producer of Notion API writes.
The existing HTTP listener serves POST /webhooks/notion/<opaque-route> as well
as /mcp and /health. Never expose /mcp to unauthenticated internet callers.

## Per-subscription configuration contract

NOTION_WEBHOOK_CONFIG_JSON is a JSON object with an absolute ledgerPath and
nonempty bindings. Every binding must contain a unique opaque route (24-96
characters, letters/numbers/underscore/hyphen), subscriptionId, integrationId,
workspaceId, accountId and apiVersion (e.g., 2026-03-11). The accountId must
be the exact existing Notion account mapping owned by the runner.
The same subscriptionId cannot be bound twice. A binding also contains a
verificationToken held in the managed secret system; never print its value,
or, during initial subscription setup only, an absolute bootstrapFile.

Keep this config in a protected runner setting, not in source or Notion.
Do not reuse one subscription's token in a different workspace or account.

## Two-stage Notion subscription activation

1. Provision an authorized public HTTPS endpoint or reverse-proxy route
   specifically for POST /webhooks/notion/<opaque-route>.
   Configure the managed runner with bootstrapFile and no verificationToken.
2. Create the matching Notion subscription. Its initial verification challenge
   is **unsigned** and can be spoofed if an attacker learns the opaque route.
   The first well-formed token is written once to bootstrapFile, with no token
   in the HTTP response. Treat the file as untrusted provisional input.
   Independently confirm the subscription, integration, endpoint and matching
   token in the Notion verification UI. A wrong token or unexpected first
   challenge is an operator-review incident: never trust or automatically
   activate the captured token. Never copy it to docs, chat or logs.
3. Transfer the independently verified token into an owner-managed secret store.
   Replace the bootstrap binding with verificationToken, keep the same
   subscription/account/workspace/API version, and restart only the affected
   Notion MCP service through its controlled release workflow.
4. Enable page.created, page.properties_updated and page.permissions_updated
   on that exact subscription. Test the public route in an isolated environment
   before a controlled release cutover.

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
ledger. A separately authorized existing consumer must retrieve
the page under exactly the binding's account identity, reconcile current
page state and persist a separate result receipt before any actions. If
the page is inaccessible or public_url is null, treat that as unknown or
nonpublic based on current API readback; do not infer from the webhook.
This consumer and end-to-end public HTTPS subscription QA are required
before production activation. No new orchestrator is permitted.

## Windows-only ACL and reparse preflight

After staging **both existing** incoming and reconciliation JSONL files under a protected, service-owned directory, run this read-only preflight as the **same Windows identity that launches the affected Notion MCP service**:

```powershell
& .\scripts\verify-notion-webhook-windows-acl.ps1 `
  -LedgerPaths @('C:\private-notion\incoming.jsonl', 'C:\private-notion\readbacks.jsonl') `
  -ExpectedServiceSid 'S-1-5-21-REPLACE-WITH-VERIFIED-SERVICE-SID'
```

The script refuses missing files, an unexpected service SID, any reparse component in either path, untrusted owners or writable ACL grants on each ledger file and its **immediate parent**. It is read-only and has been exercised on Windows against a hardened temporary fixture and an intentionally writable fixture. It does **not** verify ancestors' effective delete/rename rights, hard-link count, future ACL changes, public HTTPS routing, the actual subscription, or the native Notion handshake. The existing Node ledger opener checks hard-link count separately. Independently inspect protected ancestor ownership/rights and actual runner identity; retain the release HOLD until those production checks and the signed native-endpoint acceptance pass. Never treat a preflight test on temporary files as production certification.

## Limits and rollback

Max request body 256 KiB; ledger 50,000 event identities or 32 MiB at startup.
The consumer bounds each ledger read before parsing, but does not implement
a streaming cursor or automatic rotation. This is a single-writer design:
never point two processes at the same ledger or replay an unknown write
outcome. Restrict ledger parent-directory write access and prevent symlink
substitution. On Windows, independently validate actual NTFS ACLs and reparse
points: POSIX permission bits alone are not sufficient. Provision protected
backups, explicit operator-directed recovery/rotation and a tested rollback
for the exact deployed service. Do not activate publicly until those runtime
controls and native end-to-end acceptance are verified.

Sources:
- https://developers.notion.com/reference/webhooks
- https://developers.notion.com/reference/webhooks-events-delivery
