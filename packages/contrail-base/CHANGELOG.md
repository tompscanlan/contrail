# @atmo-dev/contrail-base

## 0.9.1

### Patch Changes

- 4c8fedb: fix(identity): stop stranding/clobbering handles during resolution (#42)

  Backfill left a meaningful fraction of identities with a PDS but no handle.
  Two root causes:

  - `resolvePDSCached` short-circuited on any row with a non-null PDS and returned
    without ever resolving the handle. A partial resolution (slingshot can return
    a PDS without a handle under load) was therefore persisted and never healed.
    It now treats a row as a complete cache hit only when both PDS _and_ handle are
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

## 0.9.0

## 0.8.0

### Minor Changes

- d7e0936: Private-network deployment support via a new optional `ContrailConfig.networkOverrides` block.

  `networkOverrides` carries three optional subfields, all defaulting to the current public-internet behavior (omit the block entirely and nothing changes):

  - **`resolver`** — a custom `DidDocumentResolver` used during DID-doc PDS fallback, labeler-endpoint resolution, and spaces service-auth JWT verification. Lets a deployment point at a private PLC mirror or inject a custom fetch (mTLS, retry, instrumentation). Trusted; not SSRF-checked.
  - **`slingshotUrl`** — override the slingshot identity-resolver endpoint. Trusted; not SSRF-checked.
  - **`additionalAllowedHosts`** — hostnames that bypass the default SSRF guard when validating a resolved PDS or labeler endpoint. Match is exact, case-insensitive, port-agnostic (e.g. `["pds.dev.svc.cluster.local"]`). This is the only knob that widens the validator; there is no "disable SSRF" flag.

  The overrides are threaded through PDS/identity resolution (`resolvePDS`, `getPDS`, `getClient`, `resolveIdentity*`, `refreshStaleIdentities`), labeler endpoint resolution and ingest (`resolveLabelerEndpoint`, `getLabelerState`, label subscribe cycles), and service-auth verification (`buildVerifier` in both the appview router and the community integration). The in-scope `config` is now also passed at every appview call site that resolves identities or PDS endpoints — the live-ingest refresh cycle (`runIngestCycle` → `refreshStaleIdentities`), the on-demand `refresh` path, and the router actor/identity/PDS resolution paths (`getProfile`, `getFeed`, collection queries, profile hydration, notify) — so private-network deploys honor the override on those paths instead of silently falling back to the public resolver and un-widened SSRF guard.

  The SSRF guard is now a single shared validator: `validateExternalUrl(url, additionalAllowedHosts?)` is exported from `contrail-base` and consumed by both the PDS client and labeler-endpoint resolution. `validateEndpointUrl` remains exported as a thin alias for backward compatibility. This removes the previous duplicate validator (`validatePdsUrl` + `validateEndpointUrl`) where an allowlist or SSRF-rule edit could be applied to only one copy.

  Also hardens schema initialization for concurrent/Postgres deployments: a dialect-aware `addColumnIfNotExists` (Postgres `ADD COLUMN IF NOT EXISTS`; SQLite pre-check), narrow absorption of the Postgres concurrent-`CREATE` race (42P07 / 23505 on pg_type/pg_class/pg_namespace indexes), and per-statement (rather than batched) DDL during `initSchema` / `initSpacesSchema` / spaces schema. Genuine DDL errors (syntax, type mismatch, missing column/table) still propagate.

## 0.7.0
