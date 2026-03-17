import { describe, it, expect, beforeEach } from "vitest";
import type { Database, RecordRow, RelationConfig } from "../src/core/types";
import { parseHydrateParams, resolveHydrates } from "../src/core/router/hydrate";
import { createTestDbWithSchema, makeEvent, TEST_CONFIG } from "./helpers";
import { applyEvents } from "../src/core/db/records";

describe("parseHydrateParams", () => {
  const relations: Record<string, RelationConfig> = {
    rsvps: { collection: "community.lexicon.calendar.rsvp", groupBy: "status" },
    comments: { collection: "test.comment" },
  };

  it("parses valid hydrate params", () => {
    const params = new URLSearchParams({ hydrateRsvps: "5", hydrateComments: "3" });
    const result = parseHydrateParams(params, relations);
    expect(result).toEqual({ rsvps: 5, comments: 3 });
  });

  it("ignores unrelated params", () => {
    const params = new URLSearchParams({ hydrateFoo: "5", limit: "10" });
    const result = parseHydrateParams(params, relations);
    expect(result).toEqual({});
  });

  it("ignores invalid numbers", () => {
    const params = new URLSearchParams({ hydrateRsvps: "abc" });
    const result = parseHydrateParams(params, relations);
    expect(result).toEqual({});
  });

  it("ignores zero and negative", () => {
    const params = new URLSearchParams({ hydrateRsvps: "0", hydrateComments: "-1" });
    const result = parseHydrateParams(params, relations);
    expect(result).toEqual({});
  });

  it("returns empty for no hydrate params", () => {
    const params = new URLSearchParams({ limit: "50" });
    const result = parseHydrateParams(params, relations);
    expect(result).toEqual({});
  });
});

describe("resolveHydrates", () => {
  let db: Database;

  beforeEach(async () => {
    db = await createTestDbWithSchema();
  });

  it("returns empty when no hydrations requested", async () => {
    const result = await resolveHydrates(db, {}, {}, []);
    expect(result).toEqual({});
  });

  it("returns empty when no records", async () => {
    const relations = TEST_CONFIG.collections["community.lexicon.calendar.event"].relations!;
    const result = await resolveHydrates(db, relations, { rsvps: 5 }, []);
    expect(result).toEqual({});
  });

  it("hydrates related records", async () => {
    const eventUri = "at://did:plc:test/community.lexicon.calendar.event/evt1";

    // Insert event
    await applyEvents(db, [makeEvent({ uri: eventUri, rkey: "evt1", time_us: 1000 })]);

    // Insert RSVPs
    for (let i = 0; i < 3; i++) {
      await applyEvents(db, [
        makeEvent({
          uri: `at://did:plc:user${i}/community.lexicon.calendar.rsvp/r${i}`,
          did: `did:plc:user${i}`,
          collection: "community.lexicon.calendar.rsvp",
          rkey: `r${i}`,
          record: { subject: { uri: eventUri }, status: "going" },
          time_us: 2000 + i,
        }),
      ]);
    }

    const eventRow = await db
      .prepare("SELECT * FROM records WHERE uri = ?")
      .bind(eventUri)
      .first<RecordRow>();

    const relations = TEST_CONFIG.collections["community.lexicon.calendar.event"].relations!;
    const result = await resolveHydrates(db, relations, { rsvps: 10 }, [eventRow!]);

    expect(result[eventUri]).toBeDefined();
    expect(result[eventUri].rsvps).toBeDefined();
    expect(result[eventUri].rsvps["going"]).toHaveLength(3);
  });

  it("respects hydrate limit", async () => {
    const eventUri = "at://did:plc:test/community.lexicon.calendar.event/evt1";
    await applyEvents(db, [makeEvent({ uri: eventUri, rkey: "evt1", time_us: 1000 })]);

    for (let i = 0; i < 5; i++) {
      await applyEvents(db, [
        makeEvent({
          uri: `at://did:plc:user${i}/community.lexicon.calendar.rsvp/r${i}`,
          did: `did:plc:user${i}`,
          collection: "community.lexicon.calendar.rsvp",
          rkey: `r${i}`,
          record: { subject: { uri: eventUri }, status: "going" },
          time_us: 2000 + i,
        }),
      ]);
    }

    const eventRow = await db
      .prepare("SELECT * FROM records WHERE uri = ?")
      .bind(eventUri)
      .first<RecordRow>();

    const relations = TEST_CONFIG.collections["community.lexicon.calendar.event"].relations!;
    const result = await resolveHydrates(db, relations, { rsvps: 2 }, [eventRow!]);

    expect(result[eventUri].rsvps["going"].length).toBeLessThanOrEqual(2);
  });

  it("hydrates with match: 'did'", async () => {
    const did = "did:plc:shareduser";
    const eventUri = `at://${did}/community.lexicon.calendar.event/evt1`;

    // Insert event owned by this DID
    await applyEvents(db, [makeEvent({ uri: eventUri, did, rkey: "evt1", time_us: 1000 })]);

    // Insert a related record whose "author" field contains the parent's DID
    await applyEvents(db, [
      makeEvent({
        uri: `at://did:plc:other/community.lexicon.calendar.rsvp/r1`,
        did: "did:plc:other",
        collection: "community.lexicon.calendar.rsvp",
        rkey: "r1",
        record: { author: did, status: "going" },
        time_us: 2000,
      }),
    ]);

    const eventRow = await db
      .prepare("SELECT * FROM records WHERE uri = ?")
      .bind(eventUri)
      .first<RecordRow>();

    // match: "did" means matchValues are parent DIDs, and field points to where the DID is stored
    const relations: Record<string, RelationConfig> = {
      rsvps: { collection: "community.lexicon.calendar.rsvp", match: "did", field: "author", groupBy: "status" },
    };
    const result = await resolveHydrates(db, relations, { rsvps: 10 }, [eventRow!]);

    expect(result[eventUri]).toBeDefined();
    expect(result[eventUri].rsvps).toBeDefined();
    expect(result[eventUri].rsvps["going"]).toHaveLength(1);
  });

  it("groups into 'other' when groupBy value is null", async () => {
    const eventUri = "at://did:plc:test/community.lexicon.calendar.event/evt1";

    await applyEvents(db, [makeEvent({ uri: eventUri, rkey: "evt1", time_us: 1000 })]);

    // Insert RSVP without a status field — groupBy "status" should fall back to "other"
    await applyEvents(db, [
      makeEvent({
        uri: "at://did:plc:user1/community.lexicon.calendar.rsvp/r1",
        did: "did:plc:user1",
        collection: "community.lexicon.calendar.rsvp",
        rkey: "r1",
        record: { subject: { uri: eventUri } },
        time_us: 2000,
      }),
    ]);

    const eventRow = await db
      .prepare("SELECT * FROM records WHERE uri = ?")
      .bind(eventUri)
      .first<RecordRow>();

    const relations = TEST_CONFIG.collections["community.lexicon.calendar.event"].relations!;
    const result = await resolveHydrates(db, relations, { rsvps: 10 }, [eventRow!]);

    expect(result[eventUri].rsvps).toBeDefined();
    expect(result[eventUri].rsvps["other"]).toHaveLength(1);
  });
});
