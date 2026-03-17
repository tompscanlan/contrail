# Contrail

> [!WARNING]
> Work in progress! Pre-alpha, expect breaking changes.

Define collections — get automatic Jetstream ingestion, PDS backfill, user discovery, and typed XRPC endpoints. Runs on Cloudflare Workers + D1.

## Quickstart

### Dev

```bash
pnpm install
# Edit src/config.ts with your collections
pnpm generate:pull   # pull lexicons from network, auto-detect fields, generate types
pnpm dev:auto        # start wrangler dev with auto-ingestion
pnpm sync            # discover users + backfill records from PDS
```

### Production

```bash
npx wrangler d1 create contrail
# Add database_id to wrangler.toml
pnpm deploy
# to sync in production, run it locally but set your d1 to remote, then run
pnpm sync
```

Ingestion runs automatically via cron (`*/1 * * * *`). Schema is auto-initialized.

## Config

Edit `src/config.ts` — this is the only file you need to touch:

```ts
export const config: ContrailConfig = {
  collections: {
    "community.lexicon.calendar.event": {
      relations: {
        rsvps: {
          collection: "community.lexicon.calendar.rsvp",
          groupBy: "status",      // materialized counts by status
        },
      },
    },
    "community.lexicon.calendar.rsvp": {},
  },
  // profiles: ["app.bsky.actor.profile"],  ← default
  // jetstreams: [...]                       ← default: 4 Bluesky jetstream endpoints
  // relays: [...]                           ← default: 2 Bluesky relay endpoints
};
```

### What's auto-detected from lexicons

When you run `pnpm generate`, queryable fields are derived from each collection's lexicon:

- **String fields** → equality filter (`?status=going`)
- **Datetime/integer fields** → range filters (`?startsAtMin=2026-03-16&startsAtMax=2026-04-01`)
- **StrongRef fields** → `.uri` equality filter (`?subjectUri=at://...`)

You can override any auto-detected field by specifying `queryable` manually in config.

### Collection options

| Option | Default | Description |
|--------|---------|-------------|
| `queryable` | auto-detected | Override auto-detected queryable fields |
| `discover` | `true` | Find users via relays. `false` = only track known DIDs |
| `relations` | `{}` | Many-to-one relationships with materialized counts |
| `relations.*.field` | `"subject.uri"` | Field in the related record to match against |
| `relations.*.match` | `"uri"` | Match against parent's `"uri"` or `"did"` |
| `relations.*.groupBy` | — | Split counts by this field's value |
| `queries` | `{}` | Custom query handlers |

### Profiles

`profiles` is a top-level config array of collection NSIDs that contain profile records (rkey `self`). Defaults to `["app.bsky.actor.profile"]`. These are auto-added to `collections` with `{ discover: false }`. Use `?profiles=true` on any endpoint to include a `profiles` map in the response, keyed by DID, with handle and profile record data.

## API

All endpoints at `/xrpc/{nsid}.{method}`:

| Endpoint | Description |
|----------|-------------|
| `{nsid}.getRecords` | List/filter records |
| `{nsid}.getRecord` | Get single record by URI |
| `{nsid}.getUsers` | List users by record count |
| `{nsid}.getStats` | Collection statistics |
| `contrail.admin.sync` | Discover + backfill (requires `ADMIN_SECRET`) |
| `contrail.admin.getCursor` | Current cursor position |
| `contrail.admin.getOverview` | All collections summary |

### Query parameters

**Filtering:**

| Param | Example | Description |
|-------|---------|-------------|
| `actor` | `?actor=did:plc:...` or `?actor=alice.bsky.social` | Filter by DID or handle (triggers on-demand backfill) |
| `profiles` | `?profiles=true` | Include profile + identity info keyed by DID |
| `{field}` | `?status=going` | Equality filter on queryable string field |
| `{field}Min` | `?startsAtMin=2026-03-16` | Range minimum (datetime/integer fields) |
| `{field}Max` | `?endsAtMax=2026-04-01` | Range maximum (datetime/integer fields) |
| `{rel}CountMin` | `?rsvpsCountMin=10` | Minimum total relation count |
| `{rel}{Group}CountMin` | `?rsvpsGoingCountMin=10` | Minimum relation count for a specific groupBy value |
| `hydrate` | `?hydrate=rsvps:10` | Embed latest N related records per record |
| `limit` | `?limit=25` | Page size (1-100, default 50) |
| `cursor` | `?cursor=...` | Pagination cursor |

**Hydration** returns related records grouped by `groupBy` value:

```
?hydrate=rsvps:5        # latest 5 per group (going, interested, etc.)
?hydrate=rsvps:5&hydrate=followers:10   # multiple hydrations
```

### Examples (events)

```
# Upcoming events with 10+ going RSVPs, with RSVP records and profiles
/xrpc/community.lexicon.calendar.event.getRecords?startsAtMin=2026-03-16&rsvpsGoingCountMin=10&hydrate=rsvps:5&profiles=true

# Events for a specific user (by handle)
/xrpc/community.lexicon.calendar.event.getRecords?actor=alice.bsky.social&profiles=true

# Single event with counts, RSVPs, and profiles
/xrpc/community.lexicon.calendar.event.getRecord?uri=at://did:plc:.../community.lexicon.calendar.event/...&hydrate=rsvps:10&profiles=true

# RSVPs for a specific event with profiles
/xrpc/community.lexicon.calendar.rsvp.getRecords?subjectUri=at://did:plc:.../community.lexicon.calendar.event/...&profiles=true
```

## Typesafe Client Usage

You can get fully typed XRPC queries for any Contrail instance using [`@atcute/lex-cli`](https://github.com/mary-ext/atcute). The lexicon files are committed to the repo, so you can pull them directly via the git source.

### Setup

```bash
npm install @atcute/client @atcute/lexicons @atcute/lex-cli
```

Create a `lex.config.js` pointing at the Contrail instance's repo:

```js
import { defineLexiconConfig } from "@atcute/lex-cli";

export default defineLexiconConfig({
  outdir: "src/lexicon-types/",
  imports: ["@atcute/atproto"],
  pull: {
    outdir: "lexicons/",
    sources: [
      {
        type: "git",
        remote: "https://github.com/USER/REPO.git", // the Contrail instance repo
        pattern: ["lexicons-generated/**/*.json", "lexicons-pulled/**/*.json"],
      },
    ],
  },
});
```

Then pull and generate:

```bash
npx lex-cli pull && npx lex-cli generate
```

### Usage

Import the generated types (side-effect import registers them with `@atcute/client`), then query with full type safety:

```ts
import "./lexicon-types/index.js"; // registers ambient types
import { XRPC } from "@atcute/client";

const rpc = new XRPC({ handler: /* your handler */ });

const { data } = await rpc.get("community.lexicon.calendar.event.getRecords", {
  params: { status: "going", limit: 10 }, // typed params
});

data.records // typed as Record[]
```
