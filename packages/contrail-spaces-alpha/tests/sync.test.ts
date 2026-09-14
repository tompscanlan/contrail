import { Secp256k1PrivateKeyExportable } from "@atcute/crypto";
import {
  activateIsolatedPartitionStatement,
  queryIsolatedRecords,
  resolveConfig,
} from "@atmo-dev/contrail";
import { createSqliteDatabase } from "@atmo-dev/contrail/sqlite";
import {
  RepoCommit,
  serializeRecord,
  type SignedCommit,
} from "@atproto/space";
import { describe, expect, it, vi } from "vitest";
import type { RepoOp, SpaceCredentialTransport } from "../src/protocol";
import {
  DEFAULT_SPACES_SYNC_BUDGET,
  resolveSpacesSyncBudget,
  SpacesSyncEngine,
  type SpaceUserPolicy,
} from "../src/sync";
import {
  ensureSpaceWatch,
  getRepoState,
  getSpaceWatch,
  initSpacesStorage,
  type SpaceRepoState,
  type SpaceWatch,
} from "../src/storage";
import { spaceProjectionKey } from "../src/uri";

const SPACE = "at://did:plc:alice/space/garden.atmo.circle/self";
const AUDIENCE = "did:web:provider.test#spaces";
const WRITER = "did:plc:bob";
const COLLECTION = "garden.atmo.circle.note";
const EXCLUDED_COLLECTION = "garden.atmo.circle.rsvp";

const projection = resolveConfig({
  namespace: "garden.atmo.circle",
  profiles: [],
  collections: {
    note: { collection: COLLECTION },
  },
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

function encodedCommit(commit: SignedCommit): Record<string, unknown> {
  const bytes = (value: Uint8Array) => ({
    $bytes: Buffer.from(value).toString("base64url"),
  });
  return {
    ver: commit.ver,
    rev: commit.rev,
    hash: bytes(commit.hash),
    ikm: bytes(commit.ikm),
    sig: bytes(commit.sig),
    mac: bytes(commit.mac),
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

async function engineFor(
  syncBudget?: { maxIncrementalOperations?: number; recoveryBatchSize?: number },
) {
  const db = createSqliteDatabase(":memory:");
  await initSpacesStorage(db, projection);
  const engine = new SpacesSyncEngine(db, {
    projection,
    spaceTypes: {
      "garden.atmo.circle": {
        collections: [COLLECTION],
        readPolicy: "member-list",
        writePolicy: "member-list",
      },
    },
    serviceAudience: AUDIENCE,
    credentialEncryptionKey: "unused-in-direct-test",
    syncBudget,
  });
  vi.spyOn(engine.identities, "resolvePds").mockResolvedValue("https://writer.test");
  return { db, engine };
}

async function signingKey() {
  const keypair = await Secp256k1PrivateKeyExportable.createKeypair();
  const didKey = await keypair.exportPublicKey("did");
  return {
    didKey,
    signer: {
      jwtAlg: "ES256K",
      did: () => didKey,
      sign: (value: Uint8Array) => keypair.sign(value),
    },
  };
}

function validationEngine(writePolicy: SpaceUserPolicy): SpacesSyncEngine {
  const engine = new SpacesSyncEngine(createSqliteDatabase(":memory:"), {
    projection,
    spaceTypes: {
      "garden.atmo.circle": {
        collections: [COLLECTION],
        readPolicy: "member-list",
        writePolicy,
      },
    },
    serviceAudience: AUDIENCE,
    credentialEncryptionKey: "unused-in-direct-test",
  });
  vi.spyOn(engine.identities, "resolvePds").mockResolvedValue("https://authority.test");
  return engine;
}

function describedSpace(policies: {
  read: Record<string, unknown>;
  write: Record<string, unknown>;
}): SpaceCredentialTransport {
  return transportFor(() => Response.json({
    uri: SPACE,
    readPolicy: policies.read,
    writePolicy: policies.write,
    appAccess: { $type: "com.atproto.simplespace.defs#open" },
  }));
}

describe("Space policy validation", () => {
  const memberList = { $type: "com.atproto.simplespace.defs#memberListPolicy" };
  const managingApp = {
    $type: "com.atproto.simplespace.defs#managingAppPolicy",
    managingApp: AUDIENCE,
  };

  it("accepts a space whose read and write policies both match", async () => {
    await expect(validationEngine("managing-app").validateWatch(
      watch(),
      describedSpace({ read: memberList, write: managingApp }),
    )).resolves.toBeUndefined();
  });

  it("names the write side when only writes diverge", async () => {
    await expect(validationEngine("managing-app").validateWatch(
      watch(),
      describedSpace({
        read: memberList,
        write: { $type: "com.atproto.simplespace.defs#publicPolicy" },
      }),
    )).rejects.toThrow("Space write policy is not the configured managing-app policy");
  });

  it("names the read side when only reads diverge", async () => {
    await expect(validationEngine("member-list").validateWatch(
      watch(),
      describedSpace({
        read: { $type: "com.atproto.simplespace.defs#publicPolicy" },
        write: memberList,
      }),
    )).rejects.toThrow("Space read policy is not the configured member-list policy");
  });

  it("rejects a write policy managed by another application", async () => {
    await expect(validationEngine("managing-app").validateWatch(
      watch(),
      describedSpace({
        read: memberList,
        write: {
          $type: "com.atproto.simplespace.defs#managingAppPolicy",
          managingApp: "did:web:elsewhere.test#spaces",
        },
      }),
    )).rejects.toThrow("Space write policy names a different managing application");
  });
});

describe("Spaces incremental synchronization", () => {
  it("projects an update without recovering when its superseded create has no value", async () => {
    const { db, engine } = await engineFor();
    const { didKey, signer } = await signingKey();
    vi.spyOn(engine.identities, "resolveSigningKey").mockResolvedValue(didKey);
    const oldRecord = { text: "old" };
    const currentRecord = { text: "current" };
    const [oldSerialized, currentSerialized] = await Promise.all([
      serializeRecord(COLLECTION, "one", oldRecord),
      serializeRecord(COLLECTION, "one", currentRecord),
    ]);
    const commit = await RepoCommit.fromRecords([currentSerialized]).sign(
      { space: SPACE, author: WRITER, rev: "3" },
      signer,
    );
    const operations: RepoOp[] = [{
      rev: "2",
      collection: COLLECTION,
      rkey: "one",
      cid: oldSerialized.cid.toString(),
      prev: null,
    }, {
      rev: "3",
      collection: COLLECTION,
      rkey: "one",
      cid: currentSerialized.cid.toString(),
      prev: oldSerialized.cid.toString(),
      value: currentRecord,
    }];
    const transport = transportFor(() => new Response(JSON.stringify({
      ops: operations,
      commit: encodedCommit(commit),
    }), { headers: { "content-type": "application/json" } }));

    await db.batch([activateIsolatedPartitionStatement(db, {
      scope: { kind: "isolated", key: spaceProjectionKey(SPACE, 1) },
      partition: WRITER,
      generation: 1,
    })]);
    await incremental(engine)(watch(), localState(), transport, async () => {});

    const result = await queryIsolatedRecords(db, projection, {
      scope: { kind: "isolated", key: spaceProjectionKey(SPACE, 1) },
      collection: COLLECTION,
    });
    expect(result.records).toHaveLength(1);
    expect(JSON.parse(result.records[0].record!)).toEqual(currentRecord);
    expect((await getRepoState(db, watch(), WRITER))?.rev).toBe("3");
  });

  it("projects a delete without recovering when its superseded create has no value", async () => {
    const { db, engine } = await engineFor();
    const { didKey, signer } = await signingKey();
    vi.spyOn(engine.identities, "resolveSigningKey").mockResolvedValue(didKey);
    const created = await serializeRecord(COLLECTION, "one", { text: "temporary" });
    const commit = await new RepoCommit().sign(
      { space: SPACE, author: WRITER, rev: "3" },
      signer,
    );
    const operations: RepoOp[] = [{
      rev: "2",
      collection: COLLECTION,
      rkey: "one",
      cid: created.cid.toString(),
      prev: null,
    }, {
      rev: "3",
      collection: COLLECTION,
      rkey: "one",
      cid: null,
      prev: created.cid.toString(),
    }];
    const transport = transportFor(() => new Response(JSON.stringify({
      ops: operations,
      commit: encodedCommit(commit),
    }), { headers: { "content-type": "application/json" } }));

    await incremental(engine)(watch(), localState(), transport, async () => {});

    const result = await queryIsolatedRecords(db, projection, {
      scope: { kind: "isolated", key: spaceProjectionKey(SPACE, 1) },
      collection: COLLECTION,
    });
    expect(result.records).toEqual([]);
    expect(await db.prepare(
      `SELECT operation FROM isolated_record_versions
       WHERE scope_key = ? AND partition_key = ? AND partition_generation = ?`,
    ).bind(spaceProjectionKey(SPACE, 1), WRITER, 1).first()).toEqual({
      operation: "delete",
    });
    expect((await getRepoState(db, watch(), WRITER))?.rev).toBe("3");
  });

  it("counts excluded-collection operations against the whole-repo limit", async () => {
    const { engine } = await engineFor({ maxIncrementalOperations: 2 });
    let requestedLimit: string | null = null;
    const transport = transportFor((url) => {
      requestedLimit = url.searchParams.get("limit");
      return new Response(JSON.stringify({
        ops: ["one", "two", "three"].map((rkey, index): RepoOp => ({
          rev: String(index + 2),
          collection: EXCLUDED_COLLECTION,
          rkey,
          cid: null,
          prev: null,
        })),
      }), { headers: { "content-type": "application/json" } });
    });

    await expect(incremental(engine)(
      watch(),
      localState(),
      transport,
      async () => {},
    )).rejects.toThrow(/bounded operation limit/);
    expect(requestedLimit).toBe("3");
  });

  it("stops between operation pages at the reconciliation deadline", async () => {
    const { engine } = await engineFor();
    let now = 100;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    let requests = 0;
    const transport = transportFor(() => {
      requests++;
      now = 200;
      return new Response(JSON.stringify({ ops: [], cursor: "next" }), {
        headers: { "content-type": "application/json" },
      });
    });

    try {
      await expect(incremental(engine)(
        watch(),
        localState(),
        transport,
        async () => {},
        150,
      )).rejects.toThrow(/deadline reached/);
      expect(requests).toBe(1);
    } finally {
      nowSpy.mockRestore();
    }
  });
});

describe("Notification-driven Space synchronization", () => {
  it("re-asserts the configured policies before a signed push is projected", async () => {
    const db = createSqliteDatabase(":memory:");
    await initSpacesStorage(db, projection);
    await ensureSpaceWatch(db, { spaceUri: SPACE });
    const engine = new SpacesSyncEngine(db, {
      projection,
      spaceTypes: {
        "garden.atmo.circle": {
          collections: [COLLECTION],
          readPolicy: "public",
          writePolicy: "member-list",
        },
      },
      serviceAudience: AUDIENCE,
      credentialEncryptionKey: "unused-in-direct-test",
    });
    vi.spyOn(engine.identities, "resolvePds").mockResolvedValue("https://authority.test");
    const paths: string[] = [];
    // The authority widened writes to `public` while this syncer still
    // configures `member-list`.
    let writePolicy: Record<string, unknown> = {
      $type: "com.atproto.simplespace.defs#publicPolicy",
    };
    vi.spyOn(
      engine as unknown as { transport: () => Promise<SpaceCredentialTransport> },
      "transport",
    ).mockImplementation(async () => transportFor((url) => {
      paths.push(url.pathname);
      if (url.pathname === "/xrpc/com.atproto.simplespace.getSpace") {
        return Response.json({
          uri: SPACE,
          readPolicy: { $type: "com.atproto.simplespace.defs#publicPolicy" },
          writePolicy,
          appAccess: { $type: "com.atproto.simplespace.defs#open" },
        });
      }
      return Response.json({ error: "UnexpectedRequest" }, { status: 500 });
    }));

    // A signed notifyWrite proves authorship, not that the Space still matches
    // the configuration, so nothing may be fetched from the writer or ingested.
    await expect(engine.syncRepo(SPACE, WRITER, {
      rev: "2",
      hash: new Uint8Array(32),
    })).rejects.toThrow("Space write policy is not the configured member-list policy");
    expect(paths).toEqual(["/xrpc/com.atproto.simplespace.getSpace"]);
    expect((await getSpaceWatch(db, SPACE))?.lastError)
      .toContain("Space write policy is not the configured member-list policy");

    // Once the drift is resolved the same push proceeds to the writer's repo:
    // this is a policy gate, not a blanket refusal of pushed work.
    writePolicy = { $type: "com.atproto.simplespace.defs#memberListPolicy" };
    await expect(engine.syncRepo(SPACE, WRITER)).rejects.toThrow();
    expect(paths).toContain("/xrpc/com.atproto.space.getRepo");
  });
});

describe("Spaces sync budget", () => {
  it("keeps incremental and recovery bounds independent", () => {
    expect(resolveSpacesSyncBudget()).toEqual(DEFAULT_SPACES_SYNC_BUDGET);
    expect(resolveSpacesSyncBudget({ maxIncrementalOperations: 4 })).toEqual({
      maxIncrementalOperations: 4,
      recoveryBatchSize: 50,
    });
    expect(resolveSpacesSyncBudget({ recoveryBatchSize: 20 })).toEqual({
      maxIncrementalOperations: 10,
      recoveryBatchSize: 20,
    });
    expect(() => resolveSpacesSyncBudget({ recoveryBatchSize: 0 })).toThrow(
      "syncBudget.recoveryBatchSize must be an integer from 1 through 50",
    );
  });
});
