import { createSqliteDatabase } from "../src/adapters/sqlite";
import type { Database, ResolvedContrailConfig } from "../src/core/types";
import { resolveConfig } from "../src/core/types";
import { initSchema } from "../src/core/db/schema";

export function createTestDb(): Database {
  return createSqliteDatabase(":memory:");
}

export const TEST_CONFIG: ResolvedContrailConfig = resolveConfig({
  namespace: "com.example",
  collections: {
    "community.lexicon.calendar.event": {
      queryable: {
        mode: {},
        name: {},
        startsAt: { type: "range" },
      },
      relations: {
        rsvps: {
          collection: "community.lexicon.calendar.rsvp",
          groupBy: "status",
          groups: {
            interested: "community.lexicon.calendar.rsvp#interested",
            going: "community.lexicon.calendar.rsvp#going",
            notgoing: "community.lexicon.calendar.rsvp#notgoing",
          },
        },
      },
    },
    "community.lexicon.calendar.rsvp": {
      references: {
        event: {
          collection: "community.lexicon.calendar.event",
          field: "subject.uri",
        },
      },
    },
  },
});

export async function createTestDbWithSchema(): Promise<Database> {
  const db = createTestDb();
  await initSchema(db, TEST_CONFIG);
  return db;
}

export function makeEvent(overrides: Partial<{
  uri: string;
  did: string;
  collection: string;
  rkey: string;
  cid: string | null;
  record: any;
  time_us: number;
  indexed_at: number;
  operation: "create" | "update" | "delete";
}> = {}) {
  return {
    uri: overrides.uri ?? "at://did:plc:test/community.lexicon.calendar.event/abc",
    did: overrides.did ?? "did:plc:test",
    collection: overrides.collection ?? "community.lexicon.calendar.event",
    rkey: overrides.rkey ?? "abc",
    cid: overrides.cid ?? "bafyabc",
    record: overrides.record !== undefined
      ? (typeof overrides.record === "string" ? overrides.record : JSON.stringify(overrides.record))
      : JSON.stringify({ name: "Test Event", startsAt: "2026-04-01T10:00:00Z", mode: "online" }),
    time_us: overrides.time_us ?? 1000000,
    indexed_at: overrides.indexed_at ?? Date.now(),
    operation: overrides.operation ?? ("create" as const),
  };
}
