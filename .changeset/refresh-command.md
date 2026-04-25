---
"@atmo-dev/contrail": minor
---

add `refresh` — a "catch-up" CLI + method that reconciles every known DID's PDS against the DB and reports what was missed.

unlike `backfillAll`, it ignores the `backfills` state table and sweeps fresh. useful after jetstream outages or after leaving a dev deployment idle for days.

each record in each configured collection is classified as:

- **missing** — PDS has it, DB doesn't
- **stale update** — DB has it with a different CID, *and* the DB row was written before the ignore window (default 60s, configurable)
- **in sync** — same CID, or DB row is within the ignore window

```bash
pnpm contrail refresh                   # totals
pnpm contrail refresh --by-collection   # + per-nsid breakdown
pnpm contrail refresh --ignore-window 30
```

programmatic: `contrail.refresh({ ignoreWindowMs, concurrency })` returns per-collection stats + totals. also exported from `@atmo-dev/contrail/workers` as `refresh()` for wrangler-backed deployments.

safe to run repeatedly — each pass converges toward zero. not a replacement for `ingest` / `runPersistent` (walks every user's history, which is expensive); use for after-outage reconciliation or dev-idle catch-up.

also extends `ExistingRecordInfo` with an `indexed_at: number | null` field so callers using `lookupExistingRecords` can inspect per-row freshness without a second query.
