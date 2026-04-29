# Contrail patterns (for AI agents)

Companion to <https://flo-bit.dev/contrail/llms-full.txt> — that's the full reference. This file is the opinionated short version: how this template uses contrail in practice, so you don't have to derive it from docs every time.

## Reading data — almost always `listRecords`

The default pattern for *any* data fetch is:

```ts
const client = getServerClient(platform!.env.DB);          // server
// or: const client = getClient();                          // browser

const res = await client.get('<ns>.<short>.listRecords', {
  params: {
    limit: 50,
    sort: 'createdAt',
    order: 'desc',
    // ...filter params from contrail.config.ts `queryable` block
    // ...hydration flags (e.g. `profiles: true`)
  }
});

if (!res.ok) return { records: [] };
const records = res.data.records;  // typed against your lexicon
```

Where:
- `<ns>` is `config.namespace` from `src/lib/contrail.config.ts`.
- `<short>` is the key in `config.collections` (the short name, *not* the full NSID).

If the user gives a vague spec ("show me X"), the answer is almost always a `listRecords` call with a filter. Reach for `getRecord` only when you genuinely need one record by URI — listing with a filter that narrows to one is usually fine and keeps the codepath uniform.

## Filtering and hydration come from `contrail.config.ts`

Both the available filter params *and* the hydration flags are declared in `contrail.config.ts`. If a filter doesn't exist, add it there and re-run `pnpm generate:pull` — don't filter in JS after the fact.

```ts
// src/lib/contrail.config.ts
collections: {
  bookmark: {
    collection: 'app.mybookmarks.bookmark',
    queryable: {
      tag: {},                       // → ?tag=design
      createdAt: { type: 'range' }   // → ?createdAtMin=...&createdAtMax=...
    }
    // hydration: profiles, etc. — see llms-full.txt
  }
}
```

`profiles: true` joins each record's author profile into `res.data.profiles` — use this instead of fetching profiles in a loop. Same shape for any other hydration flags contrail exposes for the collection.

## Where to call from

| Where | Use | Why |
|---|---|---|
| `+page.server.ts`, `+layout.server.ts`, `+server.ts` | `getServerClient(platform!.env.DB)` | In-process, zero HTTP, full types |
| `.svelte` (client-side, on user action) | `getClient()` from `$lib/contrail/client` | Hits `/xrpc/` over fetch — same typed surface |
| Inside `routes/api/cron/+server.ts` | Don't call client APIs — use `contrail.ingest()` directly | That's the indexer, not a reader |

Default to server-side loading via `+page.server.ts` for initial page data. Use client-side only for live updates, infinite scroll, or post-action refetches.

## Writes — `putRecord`, `deleteRecord`, `uploadBlob`

Three helpers handle all writes. The actual SvelteKit remote functions live in `src/lib/atproto/server/repo.remote.ts`; client-friendly wrappers are in `src/lib/atproto/methods.ts`. From a `.svelte` file, always import from `methods`:

```ts
import { putRecord, deleteRecord, uploadBlob, createTID } from '$lib/atproto/methods';

await putRecord({
  collection: 'app.mybookmarks.bookmark',  // must be listed in settings.ts `collections`
  rkey: createTID(),
  record: { url, title, createdAt: new Date().toISOString() }
});
```

The collection must be in `src/lib/atproto/settings.ts` `collections` — that array drives both the OAuth scope (`scope.repo({ collection: [...] })`) *and* the runtime allowlist in `repo.remote.ts`. Adding a new writable collection means: lexicon → `contrail.config.ts` → `settings.ts` → `pnpm generate:pull`.

### Indexing happens automatically — don't call `contrail.notify` yourself

After every successful `putRecord`, the remote function calls `contrail.notify(uri, db)` so contrail re-indexes the record immediately. You do **not** need to do this in app code — and shouldn't. The next `listRecords` call will see the new record. (See `repo.remote.ts:38-44`.)

`deleteRecord` does *not* notify; deletions propagate via Jetstream within ~minute. If a record needs to disappear from the UI right away, filter it out optimistically and let the index catch up.

### Optimistic UI is still worth doing

Even with auto-notify, `putRecord` takes ~100–300ms round-trip. For interactive flows (post-as-you-type, emoji reactions, like buttons), render the local copy immediately and let the network call settle in the background — don't await before updating state.

### Blobs

`uploadBlob` handles the bytes-over-remote-function dance and auto-detects image dimensions for `aspectRatio`. Embed the returned blob in a record:

```ts
const uploaded = await uploadBlob({ blob: file });
await putRecord({
  collection: 'app.mybookmarks.thumbnail',
  rkey: createTID(),
  record: { image: uploaded, createdAt: new Date().toISOString() }
});
```

To enable blob uploads, add `scope.blob({ accept: ['image/*'] })` to `scopes` in `settings.ts` (and adjust `accept` for the mime types you allow). Without that scope, the OAuth flow won't grant blob-write permission and uploads 401.

## Spaces and communities — opt-in, default to *not* using them

The template ships with public records only. **Don't enable spaces or communities unless the user's data model genuinely needs them** — they add config, secrets, and a parallel set of XRPC methods (`<ns>.space.*`, `<ns>.community.*`). For 80% of atproto apps (public posts, public lists, public anything), skip this whole section.

### When to reach for **spaces**

When records *can't* be public on a PDS — invite-only event guest lists, members-only forum threads, private group calendars. Records inside a space are gated by an ACL (the space's member list), not visible to the world.

The mental model: *a space is a bag of records with one lock; the member list says who has the key*. One owner, one record type per space, every member has read + write. No nested ACLs — richer permission models = more spaces.

To enable, add a `spaces` block to `contrail.config.ts`:

```ts
spaces: {
  type: 'app.example.event.space',     // NSID for the space record type
  serviceDid: 'did:web:example.com',   // DID for the worker — must be your deployed domain
}
```

Plus per-collection: `allowInSpaces: false` to keep a collection public-only.

`serviceDid` is the catch — `did:web:<your-domain>` requires serving a `/.well-known/did.json` at that domain. The user has to set this up; the AI can scaffold the JSON file but the domain has to be theirs. For dev, skip spaces entirely.

`listRecords` becomes auth-aware: anonymous → public only; authenticated with no `spaceUri` → public ∪ caller's spaces; with `?spaceUri=...` → that one space (ACL-checked). Records from spaces carry a `space: <spaceUri>` field in responses.

#### Default to a separate D1 for spaces data

When enabling spaces, provision a **second** D1 database for the spaces tables — keep the public-records DB and the permissioned-data DB isolated. Contrail supports this natively via a `spacesDb` parameter; defaults to the main DB if omitted, but don't omit it.

```sh
npx wrangler d1 create <project>-spaces
# → copy database_id into wrangler.jsonc
```

`wrangler.jsonc`:

```jsonc
"d1_databases": [
  { "binding": "DB",         "database_name": "<project>",        "database_id": "..." },
  { "binding": "SPACES_DB",  "database_name": "<project>-spaces", "database_id": "..." }
]
```

Then thread it through `src/lib/contrail/index.ts`:

```ts
export async function ensureInit(db: D1Database, spacesDb: D1Database) {
  if (!initialized) {
    await contrail.init(db, spacesDb);
    initialized = true;
  }
}

export function getServerClient(db: D1Database, spacesDb: D1Database, did?: string): Client {
  return createServerClient(async (req) => {
    await ensureInit(db, spacesDb);
    return handle(req, db, spacesDb) as Promise<Response>;
  }, did);
}
```

Every call site (`+page.server.ts`, `+layout.server.ts`, `routes/api/cron/+server.ts`, `repo.remote.ts`) needs to pass `platform.env.SPACES_DB` alongside `platform.env.DB`.

Full reference: <https://flo-bit.dev/contrail/docs/spaces/llms.txt>.

### When to reach for **communities**

When records should be published under a *shared* identity — a team's calendar, a project's announcements, not "user X posted this". A community is a DID that multiple members can act *through*, with tiered access levels.

Two modes:
- **Minted** — contrail creates a fresh `did:plc` and holds its keys. Irreversible without the recovery rotation key (returned once at mint time).
- **Adopted** — contrail takes over an existing account via an app password. Reversible — the owner can revoke the app password anytime.

Communities sit *on top of* spaces — a community owns spaces, and member-access-levels decide who can act in which spaces.

Config:

```ts
community: {
  masterKey: env.COMMUNITY_MASTER_KEY,   // 32-byte encryption key (secret!)
  serviceDid: 'did:web:example.com',
  levels: ['admin', 'moderator'],        // your custom levels, ranked highest-first
}
```

`masterKey` envelope-encrypts stored credentials (app passwords for adopted communities, signing keys for minted). Set as a wrangler secret: `pnpm env:generate-secret | npx wrangler secret put COMMUNITY_MASTER_KEY`. Never check it in.

Full reference: <https://flo-bit.dev/contrail/docs/communities/llms.txt>.

### Decision flow

Quick decision tree before adding either:

1. Are all the records the app deals with OK to be world-readable on the user's PDS? → **No spaces, no communities. Stop.**
2. Some records are private but always belong to one user? → Still no spaces; just don't show them in your UI / use atproto's own scope system. Spaces are for *shared* private data.
3. Records belong to a *group* (multiple members can read/write)? → Spaces.
4. Records should be published under a *shared identity* (the group itself "posts" things, not individual users)? → Communities (which use spaces under the hood).

If the user describes their app in two sentences and never says "members", "invite-only", "private group", or "team-owned", you don't need this section.

## End-to-end types — trust them, debug from them

Everything is typed:

- `client.get('...')` autocompletes the method name from your registered lexicons.
- `params` is typed against the `queryable` block in `contrail.config.ts`.
- `res.data.records[i].value` is typed against the lexicon record schema (the `record` block of the NSID).

**If types feel wrong, the cause is almost always one of:**
1. The collection isn't in `contrail.config.ts` yet → add it, then `pnpm generate:pull`.
2. You changed `contrail.config.ts` but didn't regenerate → run `pnpm generate:pull`.
3. The lexicon JSON in `lexicons/custom/` doesn't match what you're calling → run lexicon.garden's `validate_lexicon` MCP tool against it.
4. You're typing `res.data.records[i]` directly without checking `res.ok` first → the `!res.ok` early-return narrows the type.

When something looks off, **read the generated types in `src/lexicon-types/`** — they're the ground truth for what the API actually returns. Don't guess from the lexicon JSON.

## Profile data, specifically

Most apps want to show "who posted this" alongside records. Two paths:

1. **Hydrate via `profiles: true`** in `listRecords` — best for lists. Use `extractProfile()` from `$lib/contrail/client` to normalize the entries.
2. **Fetch separately** for one-off lookups. Don't loop fetches; if you need many, use `listRecords` with a filter on `did`.

Whatever you do, **don't fetch profiles from `app.bsky.actor.getProfile` over the network in a loop** — that's the failure mode this hydration setup exists to avoid.
