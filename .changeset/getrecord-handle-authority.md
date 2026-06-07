---
"@atmo-dev/contrail-appview": minor
---

feat(getRecord): resolve a handle in the URI authority

`<ns>.<collection>.getRecord` now accepts an AT-URI whose authority is a handle
(e.g. `at://alice.bsky.social/<coll>/<rkey>`), not just a DID. The authority is
resolved through the same `resolveActor` the actor-param endpoints
(`listRecords`/`getProfile`/`getFeed`) already use — local-first via the indexed
`identities` table, network only on a miss — so a handle-routed consumer can
hand the URI straight to `getRecord` instead of resolving handle→DID itself.

Fully backward compatible: a DID authority resolves to itself unchanged, so
existing DID-URI callers are unaffected. Applies to both the public and
per-space (`?spaceUri=`) paths. `getRecord` stays a fast read — no blocking
backfill is added. Unresolvable authority → 400 (matching `listRecords`),
missing record → 404. Parsing now uses atcute's `parseResourceUri`, which
validates the actor / NSID / record-key shapes, so a syntactically invalid
`uri` returns 400 instead of silently 404ing.

Internal: the hand-rolled `parseAtUri` (notify) is reimplemented over atcute's
`parseCanonicalResourceUri`; its signature is unchanged.
