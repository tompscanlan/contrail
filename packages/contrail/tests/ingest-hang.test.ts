import { describe, it, expect, vi, beforeEach } from "vitest";

// Controller the mocked Jetstream reads from. `script` is an async-generator
// factory each test sets; `abort` lets a test stop a still-running flood once
// its assertions are done (so the buggy path can't leak timers post-failure).
const jetstream = vi.hoisted(() => ({
  script: null as
    | null
    | ((self: { cursor: number | null }) => AsyncGenerator<unknown>),
  abort: false,
}));

// Replace the real WebSocket-backed subscription with one driven by the test's
// `script`. `self.cursor` mirrors the real subscription's progress cursor,
// which ingestEvents reads back as `lastCursor`.
vi.mock("@atcute/jetstream", () => {
  class MockJetstreamSubscription {
    cursor: number | null = null;
    constructor(opts: { cursor?: number }) {
      this.cursor = typeof opts?.cursor === "number" ? opts.cursor : null;
    }
    async *[Symbol.asyncIterator]() {
      if (!jetstream.script) throw new Error("test did not set jetstream.script");
      yield* jetstream.script(this);
    }
  }
  return { JetstreamSubscription: MockJetstreamSubscription };
});

import { ingestEvents } from "../src/core/jetstream";
import { resolveConfig } from "../src/core/types";
import type { ContrailConfig } from "../src/core/types";

const silentLogger = { log() {}, warn() {}, error() {} };

function commitEvent(
  did: string,
  collection: string,
  time_us: number,
  rkey: string,
) {
  return {
    kind: "commit" as const,
    time_us,
    did,
    commit: {
      collection,
      operation: "create" as const,
      rkey,
      cid: "bafy" + rkey,
      record: { name: "Test Event", startsAt: "2026-04-01T10:00:00Z", mode: "online" },
    },
  };
}

/** A discoverable-only config — events flow straight into `collected`. */
function discoverableConfig(): ContrailConfig {
  return {
    ...resolveConfig({
      namespace: "com.example",
      collections: {
        event: { collection: "community.lexicon.calendar.event" },
      },
    }),
    logger: silentLogger,
  };
}

/** A config with a dependent collection so unknown-DID events get filtered. */
function dependentConfig(): ContrailConfig {
  return {
    ...resolveConfig({
      namespace: "com.example",
      collections: {
        event: { collection: "community.lexicon.calendar.event" },
        follow: { collection: "app.bsky.graph.follow", discover: false },
      },
    }),
    logger: silentLogger,
  };
}

/** Reject if `p` hasn't settled within `ms` — turns a hang into a test failure
 *  instead of a frozen run. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`ingestEvents did not return within ${ms}ms (${label})`)),
      ms,
    );
  });
  return Promise.race([p.finally(() => clearTimeout(timer)), timeout]);
}

describe("ingestEvents — bounded by the safety timeout (om-dua7)", () => {
  beforeEach(() => {
    jetstream.script = null;
    jetstream.abort = false;
  });

  it("returns within the safety timeout when the stream replays history then goes quiet", async () => {
    jetstream.script = async function* (self: { cursor: number | null }) {
      // One historical commit (time_us in the past, so never "caught up").
      self.cursor = 1_000_000;
      yield commitEvent("did:plc:author", "community.lexicon.calendar.event", 1_000_000, "evt1");
      // Quiet stream: no further events ever arrive.
      await new Promise(() => {});
    };

    const result = await withTimeout(
      ingestEvents(discoverableConfig(), 999_999, 150),
      2_000,
      "quiet stream",
    );

    expect(result.events).toHaveLength(1);
    expect(result.events[0].uri).toBe(
      "at://did:plc:author/community.lexicon.calendar.event/evt1",
    );
    // The replayed cursor must come back so the caller can persist it.
    expect(result.lastCursor).toBe(1_000_000);
  });

  it("returns by the safety timeout even when every arriving event is filtered out", async () => {
    const knownDids = new Set<string>(); // no known DIDs -> every event filtered
    jetstream.script = async function* (self) {
      let t = 1_000_000;
      for (let i = 0; i < 2_000 && !jetstream.abort; i++) {
        t += 1_000;
        self.cursor = t;
        yield commitEvent("did:plc:stranger", "app.bsky.graph.follow", t, "f" + i);
        await new Promise((r) => setTimeout(r, 2));
      }
    };

    try {
      const result = await withTimeout(
        ingestEvents(dependentConfig(), 999_999, 100, knownDids),
        2_000,
        "all-filtered flood",
      );

      expect(result.events).toHaveLength(0); // all filtered, nothing collected
      // ...but the cursor still advanced, so the caller persists forward progress.
      expect(result.lastCursor).not.toBeNull();
      expect(result.lastCursor).toBeGreaterThan(1_000_000);
    } finally {
      jetstream.abort = true;
    }
  });
});
