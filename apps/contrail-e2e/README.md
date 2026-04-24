# contrail-e2e — end-to-end tests against a local ATProto stack

End-to-end test suite for Contrail against a sealed local ATProto stack.
Nothing touches the public ATProto — writes go to a local PDS, the local
Jetstream reads that PDS's firehose, and each test stands up its own
in-process Contrail ingester + XRPC handler to consume it.

## What's inside

| Service | Port | Purpose |
|---------|------|---------|
| PDS | 4000 | Personal Data Server (user repos) |
| PLC | 2582 | DID registry |
| Jetstream | 6008 | Firehose relay in JSON |
| TAP | 2480 | Sync/backfill relay |
| PostgreSQL | 5433 | Shared by PLC + Contrail |
| Maildev | 1080 | PDS email verification catcher |

## Prerequisites

Clone `atproto-devnet` as a sibling of this contrail repo:

```
some-workspace/
├── contrail/            (this repo)
└── atproto-devnet/
```

```bash
git clone https://github.com/OpenMeet-Team/atproto-devnet.git /path/to/atproto-devnet
```

## Running the tests

```bash
# From the monorepo root (one-time build of @atmo-dev/contrail)
pnpm install && pnpm build

# Bring the devnet stack up (creates .env from .env.example on first run)
cd apps/contrail-e2e
pnpm stack:up

# Run the suite
pnpm test:e2e          # once
pnpm test:e2e:watch    # re-run on change
```

> **Note:** `up` and `down` are reserved by pnpm (aliases for `update`), so
> the stack scripts are prefixed `stack:` to disambiguate. The test scripts
> are named `test:e2e` so the monorepo-wide `pnpm test` skips them in CI
> (they need the live docker stack).

## Tests

- `tests/health.test.ts` — service health checks (PLC, PDS, TAP, Jetstream)
- `tests/ingest-roundtrip.test.ts` — publish → index roundtrip. Creates a
  fresh PDS account, publishes a calendar event and an RSVP, and verifies
  both the record and its `rsvpsGoingCount` via an in-process XRPC handler.
- `tests/cursor-resume.test.ts` — regression for `runPersistent`'s durable
  cursor. Starts the ingester, publishes A, stops the ingester, publishes
  B + updates B + deletes A, restarts, and verifies the saved cursor
  replays the gap.

Each test spins up its own `runPersistent` in-process against an isolated
postgres schema, so tests don't interfere with each other or with any
dogfooding ingester running in another terminal.

## Teardown

```bash
pnpm stack:down    # stops containers AND wipes volumes for a clean slate
```

## Namespace

These tests use `rsvp.atmo` as the Contrail namespace — same as
[atmo-events](https://github.com/flo-bit/atmo-events), so the fixtures are
compatible with that frontend. If you're running your own namespace, edit
`config.ts`.

## Why not use `apps/postgres/`?

`apps/postgres/` connects Contrail to the public Bluesky Jetstream — useful
for indexing real events, unusable for writing test fixtures. This suite
gives a sealed environment where the tests control every record.

## Overrides

Copy `.env.example` to `.env` and edit. All ports, database credentials, and
devnet hostnames are overridable.
