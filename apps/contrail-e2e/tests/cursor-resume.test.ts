/**
 * End-to-end: the ingester must resume from its persisted cursor after a
 * restart, capturing events that arrived on the firehose while it was down.
 *
 * Flow:
 *   1. Start runPersistent in-process against an isolated pg schema.
 *   2. Publish event A → wait for it to be indexed → abort the ingester and
 *      await the promise. The finally-block's final flush must persist the
 *      cursor or this test fails at step 5.
 *   3. While the ingester is DOWN: publish event B, update B, delete A.
 *   4. Restart runPersistent against the SAME schema (same cursor row).
 *   5. Assert: A is gone, B is indexed with its updated name. Those three
 *      commits can only be seen by replaying from the saved cursor — Jetstream
 *      is "live tail" without it, and the events already happened.
 *
 * Why this matters: runPersistent's whole reason to exist is durable state.
 * A silently broken cursor would pass the basic roundtrip test because there's
 * nothing to replay — every event arrives while the ingester is live. This
 * test is the only one that exercises the replay path.
 *
 * Requires `pnpm stack:up` only. Ingester runs in-process.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { CredentialManager, Client } from "@atcute/client";
import "@atcute/atproto";
import { Contrail } from "@atmo-dev/contrail";
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

describe("cursor resume (ingester stops, events pile up, ingester restarts)", () => {
  let account: TestAccount;
  let client: Client;
  let pool: pg.Pool;
  let cleanupSchema: () => Promise<void>;

  beforeAll(async () => {
    account = await createTestAccount();
    const creds = new CredentialManager({ service: PDS_URL });
    await creds.login({ identifier: account.handle, password: account.password });
    client = new Client({ handler: creds });

    const iso = await createIsolatedSchema("test_cursor");
    pool = iso.pool;
    cleanupSchema = iso.cleanup;
  });

  afterAll(async () => {
    await cleanupSchema?.();
  });

  async function queryRecord(uri: string): Promise<{ record: any } | undefined> {
    const res = await pool.query(`SELECT uri, record FROM records_event WHERE uri = $1`, [uri]);
    if (res.rows.length === 0) return undefined;
    const row = res.rows[0];
    return { record: typeof row.record === "string" ? JSON.parse(row.record) : row.record };
  }

  async function getCursor(): Promise<number | null> {
    const res = await pool.query(`SELECT time_us FROM cursor WHERE id = 1`);
    if (res.rows.length === 0) return null;
    return Number(res.rows[0].time_us);
  }

  it("resumes from saved cursor and picks up commits issued while down", async () => {
    const db = createPostgresDatabase(pool);
    // Go through the Contrail wrapper so the config is resolved; raw
    // runPersistent expects a resolved config.
    const contrail = new Contrail({ ...baseConfig, db });
    await contrail.init();
    const runOpts = { batchSize: 50, flushIntervalMs: 500 };

    // ---- Phase 1: start ingester, publish A, verify indexed ----
    const c1 = new AbortController();
    const ingest1 = contrail.runPersistent({ ...runOpts, signal: c1.signal });

    const nameA = `A-${Date.now()}`;
    const aRes = await client.post("com.atproto.repo.createRecord", {
      input: {
        repo: account.did,
        collection: EVENT_NSID,
        record: {
          $type: EVENT_NSID,
          name: nameA,
          createdAt: new Date().toISOString(),
          startsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
          mode: `${EVENT_NSID}#inperson`,
          status: `${EVENT_NSID}#scheduled`,
        },
      },
    });
    expect(aRes.ok).toBe(true);
    if (!aRes.ok) throw new Error("unreachable");
    const uriA = aRes.data.uri;

    await waitFor(() => queryRecord(uriA), { label: `A indexed (${uriA})` });
    const cursorAfterA = await getCursor();
    expect(cursorAfterA, "cursor must be persisted after first flush").not.toBeNull();

    // ---- Phase 2: stop ingester ----
    c1.abort();
    await ingest1;

    const cursorAfterStop = await getCursor();
    expect(cursorAfterStop).toBe(cursorAfterA);

    // ---- Phase 3: mutate while ingester is DOWN ----
    const nameB = `B-${Date.now()}`;
    const bRes = await client.post("com.atproto.repo.createRecord", {
      input: {
        repo: account.did,
        collection: EVENT_NSID,
        record: {
          $type: EVENT_NSID,
          name: nameB,
          createdAt: new Date().toISOString(),
          startsAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
          mode: `${EVENT_NSID}#inperson`,
          status: `${EVENT_NSID}#scheduled`,
        },
      },
    });
    expect(bRes.ok).toBe(true);
    if (!bRes.ok) throw new Error("unreachable");
    const uriB = bRes.data.uri;
    const rkeyB = uriB.split("/").pop()!;
    const rkeyA = uriA.split("/").pop()!;

    const nameBUpdated = `${nameB}-renamed`;
    const putRes = await client.post("com.atproto.repo.putRecord", {
      input: {
        repo: account.did,
        collection: EVENT_NSID,
        rkey: rkeyB,
        record: {
          $type: EVENT_NSID,
          name: nameBUpdated,
          createdAt: new Date().toISOString(),
          startsAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
          mode: `${EVENT_NSID}#inperson`,
          status: `${EVENT_NSID}#scheduled`,
        },
      },
    });
    expect(putRes.ok).toBe(true);

    const delRes = await client.post("com.atproto.repo.deleteRecord", {
      input: { repo: account.did, collection: EVENT_NSID, rkey: rkeyA },
    });
    expect(delRes.ok).toBe(true);

    // Confirm the DB didn't move while the ingester was down.
    expect(await queryRecord(uriA), "A must still be indexed — nobody is consuming").toBeDefined();
    expect(await queryRecord(uriB), "B should not be indexed yet — ingester is down").toBeUndefined();

    // ---- Phase 4: restart ingester, assert replay ----
    const c2 = new AbortController();
    const ingest2 = contrail.runPersistent({ ...runOpts, signal: c2.signal });

    try {
      const indexedB = await waitFor(
        async () => {
          const r = await queryRecord(uriB);
          return r && r.record.name === nameBUpdated ? r : undefined;
        },
        { label: `B replayed with updated name` },
      );
      expect(indexedB.record.name).toBe(nameBUpdated);

      await waitFor(
        async () => ((await queryRecord(uriA)) === undefined ? true : undefined),
        { label: `A deletion replayed` },
      );

      const cursorAfterReplay = await getCursor();
      expect(cursorAfterReplay).not.toBeNull();
      expect(cursorAfterReplay!).toBeGreaterThan(cursorAfterStop!);
    } finally {
      c2.abort();
      await ingest2;
    }
  }, 60_000);
});
