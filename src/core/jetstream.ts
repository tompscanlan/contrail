import { JetstreamSubscription } from "@atcute/jetstream";
import type { ContrailConfig, IngestEvent, Database } from "./types";
import { getCollectionNames, getDependentCollections, DEFAULT_FEED_MAX_ITEMS } from "./types";
import { initSchema, getLastCursor, saveCursor, applyEvents, pruneFeedItems } from "./db";
import { refreshStaleIdentities } from "./identity";

const BATCH_SIZE = 50;

// Cache state in memory across ingest cycles (survives within the same Worker isolate)
let cachedKnownDids: Set<string> | undefined;
let schemaInitialized = false;
let lastFeedPruneMs = 0;
const FEED_PRUNE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export async function ingestEvents(
  config: ContrailConfig,
  cursor: number | null,
  safetyTimeoutMs: number = 25_000,
  knownDids?: Set<string>
): Promise<{ events: IngestEvent[]; lastCursor: number | null }> {
  const startTimeUs = Date.now() * 1000;
  const deadline = Date.now() + safetyTimeoutMs;
  const collected: IngestEvent[] = [];

  const collections = getCollectionNames(config);
  const dependentCollections = new Set(getDependentCollections(config));
  const urls = config.jetstreams ?? [];

  const subscription = new JetstreamSubscription({
    url: urls,
    wantedCollections: collections,
    ...(cursor !== null ? { cursor } : {}),
    onConnectionOpen() {
      console.log("Connected to Jetstream");
    },
    onConnectionClose(event) {
      console.log(
        `Disconnected from Jetstream: ${event.code} ${event.reason}`
      );
    },
    onConnectionError(event) {
      console.error("Jetstream error:", event.error);
    },
  });

  for await (const event of subscription) {
    if (event.kind === "commit") {
      const { commit } = event;

      if (dependentCollections.has(commit.collection) && knownDids) {
        if (!knownDids.has(event.did)) continue;
      }

      const now = Date.now();
      const uri = `at://${event.did}/${commit.collection}/${commit.rkey}`;

      collected.push({
        uri,
        did: event.did,
        time_us: event.time_us,
        collection: commit.collection,
        operation: commit.operation as "create" | "update" | "delete",
        rkey: commit.rkey,
        cid: commit.operation === "delete" ? null : commit.cid,
        record:
          commit.operation === "delete"
            ? null
            : JSON.stringify(commit.record),
        indexed_at: now * 1000,
      });

      if (knownDids && !dependentCollections.has(commit.collection)) {
        knownDids.add(event.did);
      }
    }

    if (event.time_us >= startTimeUs) {
      console.log("Caught up to present, stopping ingestion");
      break;
    }

    if (Date.now() >= deadline) {
      console.log("Safety timeout reached, stopping ingestion");
      break;
    }
  }

  const lastCursor = subscription.cursor || null;
  return { events: collected, lastCursor };
}

// Run a full ingest cycle: init schema, load cursor, ingest, apply, save cursor
export async function runIngestCycle(
  db: Database,
  config: ContrailConfig,
  timeoutMs: number = 25_000
): Promise<void> {
  if (!schemaInitialized) {
    await initSchema(db, config);
    schemaInitialized = true;
  }

  const cursor = await getLastCursor(db);
  const collections = getCollectionNames(config);

  console.log(
    `Starting ingestion. Cursor: ${cursor ?? "none"}, Collections: ${collections.join(", ")}`
  );

  // Load known DIDs for filtering dependent collections
  const dependentCollections = getDependentCollections(config);
  let knownDids: Set<string> | undefined;

  if (dependentCollections.length > 0) {
    if (cachedKnownDids) {
      knownDids = cachedKnownDids;
      console.log(`Using cached known DIDs (${knownDids.size} users)`);
    } else {
      const result = await db
        .prepare("SELECT did FROM identities")
        .all<{ did: string }>();
      knownDids = new Set((result.results ?? []).map((r) => r.did));
      cachedKnownDids = knownDids;
      console.log(`Loaded ${knownDids.size} known DIDs from database`);
    }
  }

  const { events, lastCursor } = await ingestEvents(
    config,
    cursor,
    timeoutMs,
    knownDids
  );

  console.log(`Received ${events.length} events from Jetstream`);

  for (let i = 0; i < events.length; i += BATCH_SIZE) {
    const batch = events.slice(i, i + BATCH_SIZE);
    await applyEvents(db, batch, config);
  }

  // Refresh stale/missing identities for DIDs in this batch
  const uniqueDids = [...new Set(events.map((e) => e.did))];
  if (uniqueDids.length > 0) {
    try {
      await refreshStaleIdentities(db, uniqueDids);
    } catch (err) {
      console.warn(`Identity refresh failed: ${err}`);
    }
  }

  if (lastCursor !== null) {
    await saveCursor(db, lastCursor);
    console.log(`Saved cursor: ${lastCursor}`);
  }

  // Prune feed items hourly
  if (config.feeds && Date.now() - lastFeedPruneMs > FEED_PRUNE_INTERVAL_MS) {
    const maxItems = Math.max(
      ...Object.values(config.feeds).map((f) => f.maxItems ?? DEFAULT_FEED_MAX_ITEMS)
    );
    const pruned = await pruneFeedItems(db, maxItems);
    if (pruned > 0) console.log(`Pruned ${pruned} old feed items`);
    lastFeedPruneMs = Date.now();
  }

  console.log(`Ingestion complete. Stored ${events.length} events.`);
}
