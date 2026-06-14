---
"@atmo-dev/contrail-appview": patch
"@atmo-dev/contrail-base": patch
---

Skip the feed-items prune sweep on ticks that ingested nothing feed-relevant.

The cron ingest path ran an unconditional bounded feed sweep every tick, and the persistent path ran one every sweep interval, regardless of whether any feed actually changed. Because a feed can only exceed its cap right after a feed-mutating record (event fan-out or follow backfill) is applied, the sweep was a no-op on the overwhelming majority of ticks — yet still issued a cutoff `DELETE` (plus its index probe) for every actor every time. On a live deployment this was ~98% of all D1 queries and the single largest query by total runtime, almost all of it deleting zero rows.

The sweep now runs only when the current tick (cron) or a batch since the last sweep (persistent) ingested a feed-mutating collection, plus a recovery interval (`FEED_PRUNE_RECOVERY_INTERVAL_MS`, 6h) so pre-existing over-cap rows from a lowered cap or a bulk import still drain. New `getFeedMutatingNsids(config)` derives the feed-mutating NSID set from the configured feed targets and follow collections.

The recovery interval tracks when a *full sweep pass* over every actor last completed, not the last slice. While a pass is overdue the sweep keeps advancing one bounded slice per tick until the rolling cursor wraps, then resets the clock — so a full drain is guaranteed at least every recovery interval (plus the pass's lap time) even on a deployment with more actors than fit in one slice. A per-slice clock would instead let a feed touched just after the cursor passed it wait many intervals to be revisited.

The recovery sweep now also runs on a fully idle persistent stream (it previously sat behind the empty-buffer early return and never fired without events), and the `notifyOfUpdate` ingest path runs the same recovery-aware gate after applying records (via the shared `runGatedFeedPrune`), so a notify-only deployment completes a full sweep pass per recovery interval instead of bypassing the sweep or pruning one arbitrary slice per call.

The sweep advances a rolling cursor bounded to `FEED_PRUNE_SWEEP_ACTORS` per tick, so the slice triggered by a mutation is not necessarily the actor the mutation touched: a fan-out follower outside the current cursor page is pruned by a later slice within the recovery interval, not instantly. This is deliberate — per-tick cost stays bounded by the slice budget rather than by fan-out size (a popular author has unboundedly many followers, and a per-follower or set-based cutoff would blow either the per-tick subrequest budget or D1's per-query CPU limit). feed_items is a soft cache, so a follower sitting a few rows over cap until the next slice is harmless. Pruning correctness is otherwise unchanged ("a few over cap briefly" was already accepted); idle deployments drop from a full sweep every tick to a slice roughly every recovery interval.
