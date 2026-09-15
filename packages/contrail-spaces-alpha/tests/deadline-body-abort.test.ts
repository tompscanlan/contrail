// Re-review of flo-bit/contrail#95 at head 8de9ba0 ("integrate feedback").
// Observed live against pds.opnmt.net first (spike/finding3-pagination.mjs,
// PHASE B): the new reconciliation deadline fired between response headers and
// body read, and instead of SyncDeadlineExceededError the engine logged
//   "incremental sync fell back to recovery ... TypeError: Cannot read
//    properties of undefined (reading 'ops')"
// and answered by downloading the whole repo. This file pins the mechanism
// deterministically. Local evidence only — bead om-m2u6x.
import { resolveConfig } from "@atmo-dev/contrail";
import { createSqliteDatabase } from "@atmo-dev/contrail/sqlite";
import { RepoCommit } from "@atproto/space";
import { describe, expect, it, vi } from "vitest";
import type { SpaceCredentialTransport } from "../src/protocol";
import { SpacesSyncEngine } from "../src/sync";
import {
  initSpacesStorage,
  type SpaceRepoState,
  type SpaceWatch,
} from "../src/storage";

const SPACE = "at://did:plc:alice/space/garden.atmo.circle/self";
const WRITER = "did:plc:bob";
const COLLECTION = "garden.atmo.circle.note";

const projection = resolveConfig({
  namespace: "garden.atmo.circle",
  profiles: [],
  collections: { note: { collection: COLLECTION } },
});

function watch(): SpaceWatch {
  return {
    spaceUri: SPACE,
    authorityDid: "did:plc:alice",
    spaceType: "garden.atmo.circle",
    generation: 1,
    status: "active",
    registrationExpiresAt: null,
    nextReconcileAt: 0,
    lastReconciledAt: null,
    lastError: null,
  };
}

function localState(): SpaceRepoState {
  return {
    spaceUri: SPACE,
    spaceGeneration: 1,
    repoDid: WRITER,
    pdsUrl: "https://writer.test",
    visibleWriterGeneration: 1,
    rev: "1",
    ltHash: new RepoCommit().setHash.state(),
    commitHash: new Uint8Array(32),
    removalObservations: 0,
  };
}

function transportFor(
  handler: (url: URL, init?: RequestInit) => Response | Promise<Response>,
): SpaceCredentialTransport {
  return {
    fetch: (input: string | URL | Request, init?: RequestInit) =>
      handler(new URL(input instanceof Request ? input.url : input), init),
  } as SpaceCredentialTransport;
}

async function engineFor() {
  const db = createSqliteDatabase(":memory:");
  await initSpacesStorage(db, projection);
  const engine = new SpacesSyncEngine(db, {
    projection,
    spaceTypes: {
      "garden.atmo.circle": { collections: [COLLECTION], policy: "member-list" },
    },
    serviceAudience: "did:web:test#service",
    credentialEncryptionKey: "unused-in-direct-test",
    notificationRegistration: "disabled",
    logger: { log() {}, warn() {}, error() {} },
  });
  vi.spyOn(engine.identities, "resolvePds").mockResolvedValue("https://writer.test");
  return { db, engine };
}

type IncrementalRepo = (
  watch: SpaceWatch,
  local: SpaceRepoState,
  transport: SpaceCredentialTransport,
  assertLease: () => Promise<void>,
  deadline?: number,
) => Promise<void>;

function incremental(engine: SpacesSyncEngine): IncrementalRepo {
  return (engine as unknown as { incrementalRepo: IncrementalRepo })
    .incrementalRepo.bind(engine);
}

/** A 200 whose body fails mid-read — exactly what an aborted body read looks like. */
function failingBodyResponse(): Response {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"ops":'));
      controller.error(new DOMException("The operation was aborted.", "AbortError"));
    },
  });
  return new Response(stream, {
    headers: { "content-type": "application/json" },
  });
}

describe("a deadline that fires during the body read is not reported as a deadline", () => {
  it("surfaces a TypeError instead of SyncDeadlineExceededError", async () => {
    const { engine } = await engineFor();
    let sawSignal = false;
    const transport = transportFor((_url, init) => {
      // The new code does arm an AbortSignal for the request...
      if (init?.signal) sawSignal = true;
      return failingBodyResponse();
    });

    const error = await incremental(engine)(
      watch(),
      localState(),
      transport,
      async () => {},
      Date.now() + 30_000,
    ).catch((thrown: unknown) => thrown);

    expect(sawSignal).toBe(true);
    // ...but listRepoOps RESOLVES with undefined rather than rejecting, so the
    // `if (signal?.aborted) throw new SyncDeadlineExceededError()` guard in
    // incrementalRepo never runs.
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toContain("reading 'ops'");
    expect((error as Error).name).not.toBe("SyncDeadlineExceededError");
  });

  it("means syncRepo answers an out-of-time deadline with a FULL CAR download", async () => {
    const { engine } = await engineFor();
    const calls: string[] = [];
    const transport = transportFor((url) => {
      calls.push(url.pathname.replace("/xrpc/", ""));
      if (url.pathname.endsWith("listRepoOps")) return failingBodyResponse();
      // Recovery asks for the whole repo; stop the test there.
      return new Response(JSON.stringify({ error: "StopHere" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    });

    await incremental(engine)(
      watch(),
      localState(),
      transport,
      async () => {},
      Date.now() + 30_000,
    ).catch(() => {});

    // A TypeError is not in syncRepo's rethrow list (SyncLeaseLostError /
    // SyncDeadlineExceededError), so it is swallowed into the recovery branch.
    expect(calls).toContain("com.atproto.space.listRepoOps");
  });
});

describe("the underlying hazard: an OK response with an unreadable body becomes undefined", () => {
  it("returns undefined from a 200 whose JSON does not parse", async () => {
    const { engine } = await engineFor();
    const transport = transportFor(() =>
      new Response("this is not json", {
        headers: { "content-type": "application/json" },
      }),
    );

    const error = await incremental(engine)(
      watch(),
      localState(),
      transport,
      async () => {},
    ).catch((thrown: unknown) => thrown);

    // No deadline involved at all — assertResponse returns `body as T` where
    // body is undefined, and every caller then dereferences it.
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toContain("reading 'ops'");
  });

  it("contrast: a non-OK response IS reported as a protocol error", async () => {
    const { engine } = await engineFor();
    const transport = transportFor(() =>
      new Response(JSON.stringify({ error: "InvalidRequest" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );

    const error = await incremental(engine)(
      watch(),
      localState(),
      transport,
      async () => {},
    ).catch((thrown: unknown) => thrown);

    expect(error).not.toBeInstanceOf(TypeError);
    expect((error as Error).name).toBe("SpaceProtocolError");
  });
});

describe("the intended deadline path: a throw, not a clean stop", () => {
  it("throws SyncDeadlineExceededError before the first page when out of time", async () => {
    const { engine } = await engineFor();
    let called = 0;
    const transport = transportFor(() => {
      called++;
      return new Response("{}", { headers: { "content-type": "application/json" } });
    });

    const error = await incremental(engine)(
      watch(),
      localState(),
      transport,
      async () => {},
      Date.now() - 1,
    ).catch((thrown: unknown) => thrown);

    expect((error as Error).name).toBe("SyncDeadlineExceededError");
    expect(called).toBe(0);
    // syncRepo rethrows this rather than recovering, and reconcileSpace's catch
    // then writes it into the watch row as an error string and pushes
    // nextReconcileAt out by 60s — the same treatment a real failure gets.
  });
});
