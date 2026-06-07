---
"@atmo-dev/contrail-base": patch
---

fix(identity): stop stranding/clobbering handles during resolution (#42)

Backfill left a meaningful fraction of identities with a PDS but no handle.
Two root causes:

- `resolvePDSCached` short-circuited on any row with a non-null PDS and returned
  without ever resolving the handle. A partial resolution (slingshot can return
  a PDS without a handle under load) was therefore persisted and never healed.
  It now treats a row as a complete cache hit only when both PDS *and* handle are
  present; a PDS-only row falls through to re-resolve and fill the handle, while
  still serving the known PDS (including if the re-resolution fails).
- `saveIdentity` overwrote `handle`/`pds` unconditionally, so
  `refreshStaleIdentities` (which passes a null handle through when slingshot
  omits one) could clobber a previously-resolved handle with null. The upsert now
  COALESCEs both columns: a fresh non-null value still applies (handle changes
  work), but a null never nulls a good value.

Backfill also resolves PDS endpoints up front instead of in a detached
background promise, so identity resolution no longer competes with record
backfill for slingshot — reducing the partial responses that triggered the
above in the first place.
