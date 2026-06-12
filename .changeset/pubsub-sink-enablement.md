---
"@atmo-dev/contrail-base": minor
"@atmo-dev/contrail-appview": minor
---

Make the realtime pubsub usable as a write-only record sink.

Two changes let a consumer drive a derived index (search, audit, webhook) off `realtime.pubsub` without the friction it has today:

- **`ticketSecret` is now optional.** Tickets only gate private (space) topics; a pubsub-only deployment that fans out public records needs no secret. When omitted, the ticket endpoint isn't registered and presenting a `?ticket=` returns 401 `ticket-auth-unavailable`; public `collection:` / `actor:` subscribe and all publishing still work.
- **Backfill now fans out to the realtime pubsub**, so a rebuild repopulates a pubsub-driven index instead of silently delivering zero records.

Caveat worth stating: a sink driven this way still implements the full `PubSub` interface (a no-op `subscribe`), still inherits lossy drop-oldest delivery (wrong for a durable index), and the backfill fan-out also replays history to live subscribers, who don't want it. A dedicated write-only sink avoids all three; this change is the minimal way to do it with the existing pubsub.
