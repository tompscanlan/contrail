/** Realtime without a ticketSecret.
 *
 *  Tickets gate *private* (space) topics only. A deployment that uses realtime
 *  purely to fan out *public* records — e.g. driving a derived search index off
 *  `pubsub.publish` — needs no secret. With `ticketSecret` omitted:
 *    - public `collection:` / `actor:` subscribe still works and receives the
 *      events `applyEvents` publishes (the pubsub-as-sink path), and
 *    - presenting a `?ticket=` returns 401 `ticket-auth-unavailable` instead of
 *      crashing route registration. */

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { createSqliteDatabase } from "../src/adapters/sqlite";
import { initSchema } from "../src/core/db/schema";
import { applyEvents } from "../src/core/db/records";
import { createApp } from "../src/core/router";
import { resolveConfig } from "../src/core/types";
import type { ContrailConfig, IngestEvent } from "../src/core/types";
import { InMemoryPubSub } from "../src/core/realtime/in-memory";
import type { RealtimeEvent } from "../src/core/realtime/types";

const ALICE = "did:plc:alice";
const MSG_NSID = "app.event.message";

/** Realtime configured with a pubsub but NO ticketSecret. */
function baseConfig(pubsub: InMemoryPubSub): ContrailConfig {
  return {
    namespace: "test.nosecret",
    collections: { message: { collection: MSG_NSID } },
    realtime: {
      pubsub,
      keepaliveMs: 60_000,
    },
  };
}

/** Open SSE and return an async iterator over decoded events. */
async function openSse(app: Hono, path: string): Promise<{
  events: AsyncIterator<RealtimeEvent>;
  close: () => void;
}> {
  const ac = new AbortController();
  const res = await app.fetch(
    new Request(`http://localhost${path}`, { method: "GET", signal: ac.signal })
  );
  if (!res.ok) throw new Error(`SSE open failed: ${res.status} ${await res.text()}`);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const iter: AsyncIterator<RealtimeEvent> = {
    async next() {
      while (true) {
        const sep = buf.indexOf("\n\n");
        if (sep >= 0) {
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          for (const line of frame.split("\n")) {
            if (line.startsWith("data:")) {
              try { return { done: false, value: JSON.parse(line.slice(5).trim()) }; } catch {}
            }
          }
          continue;
        }
        const { value, done } = await reader.read();
        if (done) return { done: true, value: undefined as any };
        buf += decoder.decode(value, { stream: true });
      }
    },
  };
  return {
    events: iter,
    close: () => { ac.abort(); reader.cancel().catch(() => {}); },
  };
}

describe("realtime without a ticketSecret", () => {
  it("public collection subscribe works with no secret and receives published events", async () => {
    const db = createSqliteDatabase(":memory:");
    const pubsub = new InMemoryPubSub();
    const config = resolveConfig(baseConfig(pubsub));
    await initSchema(db, config);
    const app = createApp(db, config);

    const { events, close } = await openSse(
      app,
      `/xrpc/test.nosecret.realtime.subscribe?topic=${encodeURIComponent("collection:" + MSG_NSID)}`
    );

    const e: IngestEvent = {
      uri: `at://${ALICE}/${MSG_NSID}/abc`,
      did: ALICE,
      time_us: 1_700_000_000_000_000,
      collection: MSG_NSID,
      operation: "create",
      rkey: "abc",
      cid: "bafytest",
      record: JSON.stringify({ text: "hi" }),
      indexed_at: Date.now() * 1000,
    };
    await applyEvents(db, [e], config, { pubsub });

    const next = await events.next();
    expect(next.done).toBe(false);
    const event = next.value as RealtimeEvent & { kind: "record.created" };
    expect(event.kind).toBe("record.created");
    expect(event.payload.uri).toBe(e.uri);
    close();
  });

  it("presenting a ticket with no configured secret returns 401 ticket-auth-unavailable", async () => {
    const db = createSqliteDatabase(":memory:");
    const pubsub = new InMemoryPubSub();
    const config = resolveConfig(baseConfig(pubsub));
    await initSchema(db, config);
    const app = createApp(db, config);

    const res = await app.fetch(
      new Request(
        `http://localhost/xrpc/test.nosecret.realtime.subscribe?ticket=not-a-real-ticket`
      )
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as any;
    expect(body.reason).toBe("ticket-auth-unavailable");
  });
});
