# `@atmo-dev/contrail-spaces-alpha`

Experimental AT Protocol Spaces support for Contrail. This package is intentionally workspace-private while the upstream protocol is alpha.

Pinned compatibility tuple:

- Contrail: workspace `0.23.x`
- Spaces extension: `0.1.0-alpha.0`
- `@atproto/space`: `0.0.0-spaces-alpha-20260913191958`
- supported Lexicons: permissioned-data/Spaces alpha from 2026-09-13, i.e. the
  split `readPolicy`/`writePolicy` model introduced by atproto#5496. A PDS still
  serving the earlier single-`userPolicy` Space description is not supported.

## What it provides

- delegation-token to DPoP-bound Space credential exchange;
- encrypted, expiring Space credential storage;
- explicit Space watches and per-writer checkpoints;
- signed commit, LtHash, and full CAR verification;
- staged writer-generation recovery with atomic visibility cutover;
- incremental repo operation synchronization;
- signed notification routes, Queue jobs, leases, and scheduled reconciliation;
- exact method-bound service authentication for PDS callbacks and optional standalone APIs;
- delegation access leases or an authoritative application callback;
- independent read and write policies (`public`, native `member-list`, and
  `managing-app`) on every Space type;
- paginated discovery of owned or currently connected Spaces;
- exact-Space list/get/search/reference/relation-count queries over Contrail's isolated projection seam; and
- optional one-time-ticket, hibernating Durable Object WebSocket invalidations.

Public Contrail tables and anonymous methods are unchanged. Installing the package does not create isolated tables; `createSpacesWorker` initializes them only inside a configured application or standalone deployment.

## Entry points

```ts
import { createSpacesWorker } from "@atmo-dev/contrail-spaces-alpha/worker";
import {
  SpacesProviderClient,
  createSpace,
  createSpaceRecord,
  spacesConsumerOAuthScopes,
} from "@atmo-dev/contrail-spaces-alpha/consumer";
```

The primary deployment is integrated: the application owns OAuth refresh tokens and passes its trusted session principal to `handler.integrated(env, ctx)`. Contrail receives only one-time delegation evidence, stores an encrypted short-lived Space credential, verifies permissioned repos, and serves private projections from the same process. Set `standaloneUserApi: true` only when an independent exact-service-authenticated provider is deliberately required.

## Read and write policies

A Space carries two independent policy axes, and Contrail mirrors both. Reads and writes are configured, asserted, and decided separately:

```ts
createSpacesWorker({
  spaceTypes: {
    "net.example.notes": {
      collections: ["net.example.note"],
      readPolicy: "managing-app", // who may hold a Space credential
      writePolicy: "managing-app", // whose own repo joins the writer set
    },
  },
  // Required for any space type whose readPolicy is "managing-app".
  authorization: {
    authorize: (input) => appAllowsRead(input.userDid, input.spaceUri),
  },
  // Required for any space type whose writePolicy is "managing-app".
  writeAuthorization: {
    authorizeWrite: (input) => appAllowsWrite(input.userDid, input.spaceUri),
  },
  // ...
});
```

Both axes accept `public`, `member-list`, and `managing-app`, and the pair may differ: public-read with managing-app-write is a normal configuration. `SpacesSyncEngine` asserts both configured axes against the live authority Space description before *any* path mutates the projection — authorization, scheduled reconciliation, and notification-driven `syncRepo` alike — so a Space whose `readPolicy` or `writePolicy` has drifted from the configuration is refused rather than projected. A signed `notifyWrite` is proof of who wrote, never proof that the Space still matches the configuration, so the push path re-checks it too; one description satisfies further ingestion for 15 seconds, so a reconciliation pass does not re-describe the Space once per writer, and policy drift is noticed without recreating the Space.

`writeAuthorization.authorizeWrite` is **required** for any Space type whose `writePolicy` is `managing-app`. An application that leaves it unconfigured does not fail later at a denied write; `createSpacesWorker` throws `Managing-app write policies require options.writeAuthorization.authorizeWrite` at construction. `authorization.authorize` is required the same way for `readPolicy: "managing-app"`. Only the `managing-app` axes need a callback, so a Space type may combine a native policy on one axis with a callback on the other.

Both callbacks answer `com.atproto.simplespace.checkUserAccess`, which the authority PDS calls with `access=read` or `access=write`. The read question is "may this user hold a credential for this Space?"; the write question is "should the authority admit this user's own repo to the Space's writer set?". The write decision has user/space granularity — no collection, record, or action detail, and never a client attestation — but it is not a one-time admission: upstream `processNotifyWrite` asks again before recording a write notification, so the callback is a repeatedly evaluated write-admission check. Do not cache it as a permanent grant, and do not put expensive work behind it.

### A denied write is not a refused write

This is counter-intuitive, and an application that assumes otherwise will be wrong. On the live alpha PDS:

- `com.atproto.space.createRecord` from a member the authority denies returns `200` with a real `uri` and `cid`. The record commits to **the writer's own repo**. No error is raised anywhere in the request path.
- What the write policy controls is admission to the Space's **writer set**, which is what `com.atproto.space.listRepos` enumerates. A denied writer never appears there, so a syncer that discovers writers through `listRepos` never learns their repo exists.
- That is a discovery boundary, not confidentiality: a Space-credential holder who already knows the DID can still read those records with `com.atproto.space.listRecords?repo=<did>`. Withholding a DID from `listRepos` hides existence, not content.
- Revocation is an admission boundary too, not a retraction. After `putSimpleSpaceMember(space, { did, read: true, write: false })` the writer's later writes still return `200`, and the authority stops advancing that writer's `rev` in the writer set. A syncer holding a checkpoint for that writer sees no new records from incremental sync — but the frozen `rev` is authority metadata, not a content cutoff, and `listRepos.rev` is explicitly documented as possibly lagging the writer's host.
- **A rebuilt index can still see revoked writes.** Recovery fetches the writer's *current* CAR, which is not limited to the last revision the authority admitted. Measured with this client against the alpha PDS: a warm projection reconciled after revocation holds only the pre-revocation record, while a fresh Contrail database authorized for the same Space projects both. Visibility therefore depends on local sync history, not on authority policy alone.
- So denial guarantees no further authority admission, no writer-set metadata advance, and no further notifications for that writer. It does not guarantee deletion at the writer's PDS, refusal of credentialed retrieval by DID, or exclusion from a later full recovery.

An application that needs an unauthorized write to *fail* must refuse it in its own UI or API before calling the PDS. `writePolicy` decides what the Space publishes, not what the writer's PDS accepts. An application that needs specific contributions rejected or hidden after the fact must enforce that in its own operations and projection acceptance: neither a UI check nor a write-policy change stops a direct protocol client, and neither retracts what a fresh index can recover.

### The managing-app axes must name this Worker

`SpaceTypeConfig` stores policy *kinds*, not managing-app identities: `assertPolicy` requires every `managing-app` axis to name this Worker's own `service.audience`, and only open `appAccess` is supported. Upstream can name a different managing application on each axis, and this client refuses that arrangement rather than syncing a Space whose write decisions belong elsewhere. Acting as a neutral read-only syncer for a Space another application manages is therefore outside the alpha's role, and a future read-only client must not inherit the Worker's mandatory-authorizer rule blindly.

### Writing records

`createSpaceRecord` forwards `validate` exactly as given and omits the field by default, which selects the protocol's own mode: enforce Lexicons the PDS hosts, tolerate the ones it does not. Measured against `pds.opnmt.net` on 2026-09-13:

| Record | `validate` | Result |
|---|---|---|
| unknown custom collection | omitted | `200`, `validationStatus: "unknown"` |
| unknown custom collection | `true` | `400 Unknown lexicon type: …` |
| known `app.bsky.feed.post` with `text: 123` | omitted | `400 Expected string at $.record.text` |
| the same malformed known record | `false` | `200`, and **no** `validationStatus` field |
| valid known post | omitted | `200`, `validationStatus: "valid"` |

The default therefore keeps ordinary third-party-collection writes working while still rejecting a malformed record in a collection the PDS hosts. It is a deliberate behavior change from this package's earlier unconditional `validate: false`: a malformed record in a known collection used to commit and now fails. Both booleans remain available — `true` requires a hosted Lexicon, `false` is the legacy opt-out that reports no status at all. Validation runs at the **writer's** PDS, which need not be the authority PDS; a single-PDS deployment hides that distinction. `com.atproto.space.deleteRecord` declares no `validate` input and returns an empty body, so `deleteSpaceRecord` has no equivalent option.

## Provider requirements

A Cloudflare deployment needs:

- one D1 database;
- a Queue producer/consumer (with `waitUntil` fallback for development);
- a scheduled trigger;
- a Durable Object binding when `subscriptions` is enabled;
- the `nodejs_compat` compatibility flag; and
- a 32-byte base64 `SPACES_CREDENTIAL_ENCRYPTION_KEY` secret.

Credentials and DPoP private keys are AES-256-GCM encrypted with Space-generation-bound associated data. The D1 projection and backups still contain plaintext private records; this is access control, not end-to-end encryption.

Incremental and recovery work are tuned independently:

```ts
createSpacesWorker({
  // ...
  syncBudget: {
    maxIncrementalOperations: 10, // whole-repo operations, including excluded collections
    recoveryBatchSize: 50, // in-scope records per staged ingest batch
  },
});
```

The operation endpoint has no collection filter, because metadata from every collection is required to verify the whole-repo commit. Contrail therefore requests only enough operations to enforce the incremental bound, but a PDS response can still include unused values from excluded collections.

## Installing outside this workspace

The published alpha packages do not install cleanly on their own, and a consumer of the published `@atproto/space` inherits none of this repository's configuration. `@atproto/space@0.0.0-spaces-alpha-20260913191958` depends on `^0.0.0-spaces-alpha-20260913191958` of `@atproto/lex-data` and `@atproto/lex-cbor`, and `@atproto/common-web` carries the same caret range on `@atproto/lex-json`. A caret range over a `0.0.0` prerelease also admits the bare `0.0.0` release, and bare outranks every prerelease — while bare `@atproto/lex-data@0.0.0`, `@atproto/lex-cbor@0.0.0`, and `@atproto/lex-json@0.0.0` are each published with an unresolvable `workspace:*` dependency of their own. An unpinned install therefore resolves the bare release and dies with `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`.

Pin all three at the **root of the consuming workspace**. For pnpm 10+:

```yaml
# pnpm-workspace.yaml
overrides:
  '@atproto/lex-data': 0.0.0-spaces-alpha-20260913191958
  '@atproto/lex-cbor': 0.0.0-spaces-alpha-20260913191958
  '@atproto/lex-json': 0.0.0-spaces-alpha-20260913191958
```

npm and yarn need the same three pins in root `overrides` / `resolutions`. This cannot be shipped inside this package: pnpm reads `overrides` only from the workspace root and warns `The field "pnpm.overrides" was found in <pkg>/package.json. This will not take effect.` for any other package, so the requirement has to be documented rather than vendored. This repository applies exactly these pins in its own root `pnpm-workspace.yaml`.

## Deliberately deferred

- blobs;
- private feeds and labels;
- profile hydration;
- arbitrary private custom SQL;
- combined public/private pagination;
- client-attested `appAccess` allow-lists; and
- generic membership or invitation semantics.

See [`apps/spaces-demo`](../../apps/spaces-demo) for the complete integrated Worker + SvelteKit example.
