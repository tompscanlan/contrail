---
"@atmo-dev/contrail-appview": patch
"@atmo-dev/contrail-base": patch
---

Skip the feed-items prune sweep on ticks that ingested nothing feed-relevant.

The cron ingest path ran an unconditional bounded feed sweep every tick, and the persistent path ran one every sweep interval, regardless of whether any feed actually changed. Because a feed can only exceed its cap right after a feed-mutating record (event fan-out or follow backfill) is applied, the sweep was a no-op on the overwhelming majority of ticks — yet still issued a cutoff `DELETE` (plus its index probe) for every actor every time. On a live deployment this was ~98% of all D1 queries and the single largest query by total runtime, almost all of it deleting zero rows.

The sweep now runs only when the current tick (cron) or a batch since the last sweep (persistent) ingested a feed-mutating collection, plus a slow recovery interval (`FEED_PRUNE_RECOVERY_INTERVAL_MS`, 6h) so pre-existing over-cap rows from a lowered cap or a bulk import still drain. New `getFeedMutatingNsids(config)` derives the feed-mutating NSID set from the configured feed targets and follow collections. Pruning correctness is unchanged (feeds are caches; "a few over cap briefly" was already accepted); idle deployments drop from a full sweep every tick to ~4 per day.
