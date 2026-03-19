import { type Did } from "@atcute/lexicons";
import { isDid, isNsid } from "@atcute/lexicons/syntax";

import type { ContrailConfig, Database, IngestEvent } from "./types";
import { getDiscoverableCollections, getDependentCollections, DEFAULT_RELAYS } from "./types";
import { applyEvents } from "./db";
import { getClient } from "./client";

const PAGE_SIZE = 100;
const BATCH_SIZE = 50;
const MAX_RETRIES = 5;

const REQUEST_TIMEOUT_MS = 10_000;

async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  maxRetries = 3
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await Promise.race([
        fn(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Timeout: ${label}`)), REQUEST_TIMEOUT_MS)
        ),
      ]);
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        const delay = Math.min(1000 * 2 ** attempt, 10000);
        console.warn(
          `[retry] ${label} failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms: ${err}`
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

async function markFailed(
  db: Database,
  did: string,
  collection: string,
  error: string
): Promise<void> {
  await db
    .prepare(
      "UPDATE backfills SET retries = retries + 1, last_error = ?, completed = CASE WHEN retries + 1 >= ? THEN 1 ELSE completed END WHERE did = ? AND collection = ?"
    )
    .bind(error, MAX_RETRIES, did, collection)
    .run();
}

export async function backfillUser(
  db: Database,
  did: string,
  collection: string,
  deadline: number,
  config?: ContrailConfig
): Promise<number> {
  if (Date.now() >= deadline) return 0;

  const status = await db
    .prepare(
      "SELECT completed, pds_cursor, retries FROM backfills WHERE did = ? AND collection = ?"
    )
    .bind(did, collection)
    .first<{ completed: number; pds_cursor: string | null; retries: number }>();

  if (status?.completed) return 0;

  if (!status) {
    await db
      .prepare(
        "INSERT INTO backfills (did, collection, completed) VALUES (?, ?, 0) ON CONFLICT DO NOTHING"
      )
      .bind(did, collection)
      .run();
  }

  let currentCursor: string | undefined = status?.pds_cursor ?? undefined;

  console.log(
    `Backfilling ${collection} for ${did} (cursor: ${currentCursor ?? "start"}, retries: ${status?.retries ?? 0})`
  );

  if (!isDid(did)) {
    await markFailed(db, did, collection, `Invalid DID: ${did}`);
    return 0;
  }

  if (!isNsid(collection)) {
    await markFailed(db, did, collection, `Invalid NSID: ${collection}`);
    return 0;
  }

  let client;
  try {
    client = await withRetry(
      () => getClient(did as Did, db),
      `getClient(${did})`,
      1
    );
  } catch (err) {
    await markFailed(db, did, collection, String(err));
    return 0;
  }

  let totalInserted = 0;
  let done = false;

  try {
    while (Date.now() < deadline) {
      const response = await withRetry(
        () =>
          client.get("com.atproto.repo.listRecords", {
            params: {
              repo: did as Did,
              collection,
              limit: PAGE_SIZE,
              cursor: currentCursor,
            },
          }),
        `listRecords(${did}/${collection})`
      );

      if (!response.ok) {
        await markFailed(
          db,
          did,
          collection,
          `listRecords status ${response.status}`
        );
        return totalInserted;
      }

      if (response.data.records.length === 0) {
        done = true;
        break;
      }

      const now = Date.now();
      const events: IngestEvent[] = response.data.records.map((r) => ({
        uri: r.uri,
        did,
        collection,
        rkey: r.uri.split("/").pop()!,
        operation: "create" as const,
        cid: r.cid,
        record: JSON.stringify(r.value),
        time_us: now * 1000,
        indexed_at: now * 1000,
      }));

      for (let i = 0; i < events.length; i += BATCH_SIZE) {
        const batch = events.slice(i, i + BATCH_SIZE);
        await applyEvents(db, batch, config);
        totalInserted += batch.length;
      }

      currentCursor = response.data.cursor ?? undefined;

      await db
        .prepare(
          "UPDATE backfills SET pds_cursor = ? WHERE did = ? AND collection = ?"
        )
        .bind(currentCursor ?? null, did, collection)
        .run();

      if (!currentCursor) {
        done = true;
        break;
      }
    }
  } catch (err) {
    await markFailed(db, did, collection, String(err));
    return totalInserted;
  }

  if (done) {
    await db
      .prepare(
        "UPDATE backfills SET completed = 1 WHERE did = ? AND collection = ?"
      )
      .bind(did, collection)
      .run();
    console.log(
      `Backfill complete: ${totalInserted} records for ${did}/${collection}`
    );
  } else {
    console.log(
      `Backfill paused: ${totalInserted} records for ${did}/${collection}, will resume`
    );
  }

  return totalInserted;
}

// --- Discovery ---

interface DiscoveryPage {
  repos: { did: string }[];
  cursor?: string;
}

async function fetchPage(
  relay: string,
  collection: string,
  cursor?: string
): Promise<DiscoveryPage | null> {
  const url = new URL(
    `/xrpc/com.atproto.sync.listReposByCollection`,
    relay
  );
  url.searchParams.set("collection", collection);
  url.searchParams.set("limit", "1000");
  if (cursor) {
    url.searchParams.set("cursor", cursor);
  }

  try {
    return await withRetry(
      async () => {
        const response = await fetch(url.toString());
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        return (await response.json()) as DiscoveryPage;
      },
      `fetchPage(${relay}, ${collection})`
    );
  } catch (err) {
    console.error(
      `Discovery failed for ${collection} from ${relay} after retries: ${err}`
    );
    return null;
  }
}

async function insertDiscoveredDIDs(
  db: Database,
  dids: string[],
  collection: string
): Promise<void> {
  if (dids.length === 0) return;

  const stmt = db.prepare(
    "INSERT INTO backfills (did, collection, completed) VALUES (?, ?, 0) ON CONFLICT DO NOTHING"
  );

  const batch = dids.map((did) => stmt.bind(did, collection));

  for (let i = 0; i < batch.length; i += 50) {
    await db.batch(batch.slice(i, i + 50));
  }
}

async function saveDiscoveryState(
  db: Database,
  collection: string,
  relay: string,
  cursor: string | null,
  completed: boolean
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO discovery (collection, relay, cursor, completed) VALUES (?, ?, ?, ?) ON CONFLICT(collection, relay) DO UPDATE SET cursor = excluded.cursor, completed = excluded.completed"
    )
    .bind(collection, relay, cursor, completed ? 1 : 0)
    .run();
}

export async function discoverDIDs(
  db: Database,
  config: ContrailConfig,
  deadline: number
): Promise<string[]> {
  const collections = getDiscoverableCollections(config);
  const relays = config.relays ?? DEFAULT_RELAYS;
  if (relays.length === 0 || collections.length === 0) return [];

  const discovered: string[] = [];

  for (const collection of collections) {
    if (Date.now() >= deadline) break;

    let data: DiscoveryPage | null = null;
    let relay: string | null = null;

    for (const r of relays) {
      const row = await db
        .prepare(
          "SELECT cursor, completed FROM discovery WHERE collection = ? AND relay = ?"
        )
        .bind(collection, r)
        .first<{ cursor: string | null; completed: number }>();

      if (row?.completed) continue;

      data = await fetchPage(r, collection, row?.cursor ?? undefined);
      if (data) {
        relay = r;
        break;
      } else {
        await saveDiscoveryState(db, collection, r, null, true);
      }
    }
    if (!data || !relay) continue;

    const dids = data.repos?.map((r) => r.did) ?? [];
    await insertDiscoveredDIDs(db, dids, collection);
    discovered.push(...dids);

    for (const depCollection of getDependentCollections(config)) {
      await insertDiscoveredDIDs(db, dids, depCollection);
    }

    const completed = !data.cursor;
    await saveDiscoveryState(db, collection, relay, data.cursor ?? null, completed);
  }

  return discovered;
}
