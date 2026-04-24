/**
 * End-to-end: publish a record via the devnet PDS, verify Contrail indexes it
 * via Jetstream.
 *
 * Flow:
 *   1. Stand up an in-process Contrail against an isolated pg schema — no
 *      collision with a dogfooding `pnpm ingest` and no external processes
 *      required.
 *   2. Create a fresh PDS account + auth (unique handle per run).
 *   3. Publish records through `com.atproto.repo.createRecord` on the PDS.
 *   4. Poll the in-process XRPC handler's `rsvp.atmo.event.getRecord` until
 *      the record appears. Flush cadence is 500ms in tests, so publish →
 *      indexed is bounded by firehose propagation plus one flush.
 *   5. Assert indexed fields match what we published.
 *
 * Requires `pnpm stack:up` only. The ingester and XRPC handler run in-process.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { CredentialManager, Client } from "@atcute/client";
import "@atcute/atproto";
import { Contrail } from "@atmo-dev/contrail";
import { createHandler } from "@atmo-dev/contrail/server";
import { createPostgresDatabase } from "@atmo-dev/contrail/postgres";
import { config as baseConfig } from "../config";
import {
  createTestAccount,
  createIsolatedSchema,
  waitFor,
  PDS_URL,
  type TestAccount,
} from "./helpers";

const EVENT_NSID = "community.lexicon.calendar.event";
const RSVP_NSID = "community.lexicon.calendar.rsvp";

describe("ingest roundtrip (devnet PDS → Jetstream → Contrail)", () => {
  let account: TestAccount;
  let client: Client;
  let pool: pg.Pool;
  let cleanupSchema: () => Promise<void>;
  let handle: (req: Request) => Promise<Response>;
  let ingestController: AbortController;
  let ingestPromise: Promise<void>;

  let eventUri: string;
  let eventCid: string;
  const eventName = `devnet roundtrip ${Date.now()}`;
  const startsAt = new Date(Date.now() + 60 * 60_000).toISOString();

  beforeAll(async () => {
    // PDS auth
    account = await createTestAccount();
    const creds = new CredentialManager({ service: PDS_URL });
    await creds.login({ identifier: account.handle, password: account.password });
    client = new Client({ handler: creds });

    // Isolated schema + in-process Contrail
    const iso = await createIsolatedSchema("test_roundtrip");
    pool = iso.pool;
    cleanupSchema = iso.cleanup;
    const db = createPostgresDatabase(pool);
    const contrail = new Contrail({ ...baseConfig, db });
    await contrail.init();
    handle = createHandler(contrail);

    // In-process ingester via Contrail so the config is resolved (raw
    // runPersistent expects a resolved config — grouped counts silently
    // don't update otherwise).
    ingestController = new AbortController();
    ingestPromise = contrail.runPersistent({
      batchSize: 50,
      flushIntervalMs: 500,
      signal: ingestController.signal,
    });
  });

  afterAll(async () => {
    ingestController?.abort();
    await ingestPromise?.catch(() => {});
    await cleanupSchema?.();
  });

  async function getIndexedRecord(uri: string): Promise<any | undefined> {
    const url = `http://test/xrpc/rsvp.atmo.event.getRecord?uri=${encodeURIComponent(uri)}`;
    const res = await handle(new Request(url));
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`getRecord ${uri} → ${res.status}: ${await res.text()}`);
    // Contrail's getRecord returns the formatted row — uri/did/cid/time_us/record
    // plus flattened relation counts (e.g. rsvpsGoingCount).
    return await res.json();
  }

  it("indexes a community.lexicon.calendar.event published to devnet PDS", async () => {
    const res = await client.post("com.atproto.repo.createRecord", {
      input: {
        repo: account.did,
        collection: EVENT_NSID,
        record: {
          $type: EVENT_NSID,
          name: eventName,
          createdAt: new Date().toISOString(),
          startsAt,
          mode: `${EVENT_NSID}#inperson`,
          status: `${EVENT_NSID}#scheduled`,
        },
      },
    });
    expect(res.ok, `createRecord failed: ${JSON.stringify(res.data)}`).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    eventUri = res.data.uri;
    eventCid = res.data.cid;
    expect(eventUri).toMatch(new RegExp(`^at://${account.did}/${EVENT_NSID}/`));

    const indexed = await waitFor(() => getIndexedRecord(eventUri), { label: `event ${eventUri}` });

    expect(indexed.uri).toBe(eventUri);
    expect(indexed.did).toBe(account.did);
    expect(indexed.record.name).toBe(eventName);
    expect(indexed.record.startsAt).toBe(startsAt);
  });

  it("increments rsvpsGoingCount when an RSVP is published", async () => {
    expect(eventUri, "event must be published by the previous test").toBeTruthy();

    const res = await client.post("com.atproto.repo.createRecord", {
      input: {
        repo: account.did,
        collection: RSVP_NSID,
        record: {
          $type: RSVP_NSID,
          subject: { uri: eventUri, cid: eventCid },
          status: `${RSVP_NSID}#going`,
          createdAt: new Date().toISOString(),
        },
      },
    });
    expect(res.ok, `createRecord failed: ${JSON.stringify(res.data)}`).toBe(true);

    const indexed = await waitFor(
      async () => {
        const r = await getIndexedRecord(eventUri);
        return r && r.rsvpsGoingCount >= 1 ? r : undefined;
      },
      { label: `rsvpsGoingCount for ${eventUri}` },
    );

    expect(indexed.rsvpsGoingCount).toBe(1);
  });
});
