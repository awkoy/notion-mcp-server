# Dashboard widget operations (Notion 2026-03-11 API)

The `create_view` operation can add a widget to an existing Notion Dashboard view.
This extends the database-view path without modifying normal database view behavior.

```json
{
  "view_id": "<dashboard-view-id>",
  "data_source_id": "<specific-data-source-id>",
  "name": "Open engineering work",
  "type": "table",
  "where": { "Status": "In Progress" },
  "placement": { "type": "existing_row", "row_index": 0 }
}
```

Only dashboard widget creations use `view_id` and optional `placement`.
Do not combine `view_id` with `database_id`. Pass a valid source ID
even if the target dashboard is hosted on another database.
New rows can omit `row_index`; existing rows require an existing 0-based index.
The connector checks Dashboard type, row membership metadata and capacity
before writing (maximum 4 widgets per row; 12 total). A Dashboard cannot
be nested as a widget.

## Idempotent reconciliation

Use `ensure_dashboard_widget` for repeated automation, first with `dry_run:true`.
It checks the Dashboard's widget memberships; an exact name + source + view type
+ saved filter returns action `existing`. Saved filter property IDs are normalized
against the source schema, so filters supplied with property names also match
their API-returned internal IDs. If the name matches but any of those
properties differ, it fails closed with `dashboard_widget_conflict`.
It never assumes a name match proves the filter or source is correct.

A newly created widget returns an ID even when immediate Notion readback
has not yet reflected the change. `verified:false` means reconcile the
returned ID and dashboard membership before any retry; it does not mean
creation failed. This server serializes Dashboard create and ensure requests by
Dashboard ID, preventing same-process check-then-create races. A later ensure
for the same name is held with `dashboard_widget_verification_pending` until
the created widget becomes visible in a subsequent membership read. The
pending-ID guard lives in memory, not in a distributed transaction: another
server process, a restart, or an external Notion writer can still race.
Keep a stable idempotency_key where supported; reconcile uncertain outcomes
before retrying and do not run cross-case filter migrations.

The Dashboard layout's `configuration.rows[].widgets` is read-only:
the API accepts placement at widget creation, not arbitrary updates to row
geometry. Retrieve views with `verbose:true` to inspect full rows.
Ordinary `get_view` exposes a small `layout` summary for Dashboard
views and `dashboard_view_id` on widget views. Live Notion subscription
and connection permissions may still reject Dashboard API writes.
