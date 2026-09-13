import { Secp256k1PrivateKeyExportable } from "@atcute/crypto";
import { createServiceJwt } from "@atcute/xrpc-server/auth";
import {
  bindRecordValidationLexicons,
  createIngestEvent,
  createIsolatedProjection,
  ingestRecords,
  resolveConfig,
} from "@atmo-dev/contrail";
import { createSqliteDatabase } from "@atmo-dev/contrail/sqlite";
import { beforeAll, describe, expect, it } from "vitest";
import { createSpacesWorker } from "../src/worker";
import { ensureSpaceWatch, initSpacesStorage } from "../src/storage";
import { spaceProjectionKey } from "../src/uri";

const issuer = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
const audience = "did:web:spaces.atmo.garden#spaces";
const space = `at://${issuer}/space/garden.atmo.circle/self`;
const collection = "garden.atmo.circle.note";
let keypair: Secp256k1PrivateKeyExportable;

beforeAll(async () => {
  keypair = await Secp256k1PrivateKeyExportable.createKeypair();
});

const projection = resolveConfig({
  namespace: "garden.atmo.circle",
  profiles: [],
  collections: {
    note: { collection, validate: true },
  },
  validation: { verifyCid: false },
});

const lexicons = [{
  lexicon: 1,
  id: collection,
  defs: {
    main: {
      type: "record",
      key: "tid",
      record: {
        type: "object",
        required: ["text", "createdAt"],
        properties: {
          text: { type: "string", maxLength: 2000 },
          createdAt: { type: "string", format: "datetime" },
        },
      },
    },
  },
}] as const;

async function token(method: string) {
  return createServiceJwt({
    keypair,
    issuer: issuer as never,
    audience: audience as never,
    lxm: method as never,
  });
}

function context(): ExecutionContext {
  return {
    waitUntil() {},
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
}

describe("Spaces Worker private query boundary", () => {
  it("requires a method token and returns only the named Space", async () => {
    const db = createSqliteDatabase(":memory:");
    bindRecordValidationLexicons(projection, lexicons);
    await initSpacesStorage(db, projection);
    await ensureSpaceWatch(db, { spaceUri: space });
    const event = createIngestEvent({
      uri: `${space}/${issuer}/${collection}/3h4oqw2vvxpwz`,
      did: issuer,
      collection,
      rkey: "3h4oqw2vvxpwz",
      operation: "create",
      cid: "bafy-test",
      value: {
        $type: collection,
        text: "private hello",
        createdAt: "2026-08-21T00:00:00Z",
      },
      timeUs: 1_000_000,
      source: { id: "space-test", revision: "1", time_us: 1_000_000 },
    });
    await ingestRecords(db, [event], projection, {
      projection: createIsolatedProjection({
        scope: { kind: "isolated", key: spaceProjectionKey(space, 1) },
        partition: issuer,
        generation: 1,
        activate: true,
      }),
      skipDiagnostics: true,
    });

    const worker = createSpacesWorker({
      projection,
      lexicons,
      service: {
        endpoint: "https://spaces.atmo.garden",
        audience,
        resolver: {
          async resolve(did) {
            return {
              "@context": [],
              id: did,
              verificationMethod: [{
                id: `${did}#atproto`,
                type: "Multikey",
                controller: did,
                publicKeyMultibase: await keypair.exportPublicKey("multikey"),
              }],
            };
          },
        },
      },
      standaloneUserApi: true,
      spaceTypes: {
        "garden.atmo.circle": {
          collections: [collection],
          readPolicy: "managing-app",
          writePolicy: "member-list",
          skey: "self",
        },
      },
      authorization: { authorize: () => true },
    });
    const method = "garden.atmo.circle.note.listSpaceRecords";
    const url = `https://spaces.atmo.garden/xrpc/${method}?space=${encodeURIComponent(space)}`;
    const queued: unknown[] = [];
    const env = {
      DB: db,
      SPACES_CREDENTIAL_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      SPACES_QUEUE: { send: async (message: unknown) => { queued.push(message); } },
    } as never;

    const anonymous = await worker.fetch!(new Request(url) as never, env, context());
    expect(anonymous.status).toBe(401);

    const request = new Request(url, {
      headers: { authorization: `Bearer ${await token(method)}` },
    });
    const response = await worker.fetch!(request as never, env, context());
    expect(response.status).toBe(200);
    const body = await response.json() as { records: Array<{ value: { text: string } }> };
    expect(body.records.map((record) => record.value.text)).toEqual(["private hello"]);

    const listSpacesMethod = "garden.atmo.circle.listSpaces";
    const listSpaces = await worker.fetch!(new Request(
      `https://spaces.atmo.garden/xrpc/${listSpacesMethod}`,
      { headers: { authorization: `Bearer ${await token(listSpacesMethod)}` } },
    ) as never, env, context());
    expect(listSpaces.status).toBe(200);
    expect(await listSpaces.json()).toEqual({
      spaces: [{
        uri: space,
        authorityDid: issuer,
        type: "garden.atmo.circle",
      }],
      truncated: false,
    });

    const integrated = worker.integrated(env, context());
    expect((await integrated.listSpaceRecords<{ value: { text: string } }>({
      userDid: issuer,
      space,
      collection,
    })).records.map((record) => record.value.text)).toEqual(["private hello"]);

    const wrongMethod = new Request(url, {
      headers: {
        authorization: `Bearer ${await token("garden.atmo.circle.syncSpace")}`,
      },
    });
    expect((await worker.fetch!(wrongMethod as never, env, context())).status).toBe(401);

    const syncMethod = "garden.atmo.circle.syncSpace";
    const targetedSync = new Request(`https://spaces.atmo.garden/xrpc/${syncMethod}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await token(syncMethod)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ space, repo: "did:plc:unadvertised" }),
    });
    expect((await worker.fetch!(targetedSync as never, env, context())).status).toBe(202);
    expect(queued).toEqual([{
      kind: "reconcile",
      space,
      preferredRepo: "did:plc:unadvertised",
    }]);
  });

  it("defaults to integrated user APIs while retaining authenticated PDS callbacks", async () => {
    const worker = createSpacesWorker({
      projection,
      lexicons,
      service: {
        endpoint: "https://spaces.atmo.garden",
        audience,
      },
      spaceTypes: {
        "garden.atmo.circle": {
          collections: [collection],
          readPolicy: "member-list",
          writePolicy: "member-list",
        },
      },
    });
    const discovery = await worker.fetch!(new Request(
      "https://spaces.atmo.garden/.well-known/contrail-spaces-alpha",
    ) as never, {} as never, context());
    expect((await discovery.json() as { methods: string[] }).methods).toEqual([
      "com.atproto.space.notifyWrite",
      "com.atproto.space.notifySpaceDeleted",
    ]);
    const removed = await worker.fetch!(new Request(
      "https://spaces.atmo.garden/xrpc/garden.atmo.circle.listSpaces",
    ) as never, {} as never, context());
    expect(removed.status).toBe(404);
  });

  it("requires a policy-specific authorizer for each managing-app policy", () => {
    const base = {
      projection,
      lexicons,
      service: {
        endpoint: "https://spaces.atmo.garden",
        audience,
      },
    };
    expect(() => createSpacesWorker({
      ...base,
      spaceTypes: {
        // @ts-expect-error Policies must also be explicit at the type boundary.
        "garden.atmo.circle": { collections: [collection] },
      },
    })).toThrow(/explicit supported read policy/);
    expect(() => createSpacesWorker({
      ...base,
      spaceTypes: {
        // @ts-expect-error The write policy is required alongside the read policy.
        "garden.atmo.circle": { collections: [collection], readPolicy: "public" },
      },
    })).toThrow(/explicit supported write policy/);
    expect(() => createSpacesWorker({
      ...base,
      spaceTypes: {
        "garden.atmo.circle": {
          collections: [collection],
          readPolicy: "managing-app",
          writePolicy: "member-list",
        },
      },
    })).toThrow(/Managing-app read policies/);
    expect(() => createSpacesWorker({
      ...base,
      spaceTypes: {
        "garden.atmo.circle": {
          collections: [collection],
          readPolicy: "public",
          writePolicy: "managing-app",
        },
      },
    })).toThrow(/writeAuthorization/);
    expect(() => createSpacesWorker({
      ...base,
      spaceTypes: {
        "garden.atmo.circle": {
          collections: [collection],
          readPolicy: "public",
          writePolicy: "managing-app",
        },
      },
      writeAuthorization: { authorizeWrite: () => false },
    })).not.toThrow();
    expect(() => createSpacesWorker({
      ...base,
      spaceTypes: {
        "garden.atmo.circle": {
          collections: [collection],
          readPolicy: "member-list",
          writePolicy: "member-list",
        },
      },
    })).not.toThrow();
  });

  it("answers checkUserAccess writes from the write authorizer alone", async () => {
    const db = createSqliteDatabase(":memory:");
    bindRecordValidationLexicons(projection, lexicons);
    await initSpacesStorage(db, projection);
    await ensureSpaceWatch(db, { spaceUri: space });
    const writeChecks: Array<{ userDid: string; action: string }> = [];
    const readChecks: string[] = [];
    const worker = createSpacesWorker({
      projection,
      lexicons,
      service: {
        endpoint: "https://spaces.atmo.garden",
        audience,
        resolver: {
          async resolve(did) {
            return {
              "@context": [],
              id: did,
              verificationMethod: [{
                id: `${did}#atproto`,
                type: "Multikey",
                controller: did,
                publicKeyMultibase: await keypair.exportPublicKey("multikey"),
              }],
            };
          },
        },
      },
      spaceTypes: {
        "garden.atmo.circle": {
          collections: [collection],
          readPolicy: "managing-app",
          writePolicy: "managing-app",
          skey: "self",
        },
      },
      authorization: {
        authorize: (input) => {
          readChecks.push(input.userDid);
          return true;
        },
      },
      writeAuthorization: {
        authorizeWrite: (input) => {
          writeChecks.push({ userDid: input.userDid, action: input.action });
          return input.userDid === "did:plc:writer";
        },
      },
    });
    const env = {
      DB: db,
      SPACES_CREDENTIAL_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    } as never;
    const method = "com.atproto.simplespace.checkUserAccess";
    const check = async (user: string, access?: string) => {
      const params = new URLSearchParams({ space, user });
      if (access) params.set("access", access);
      return worker.fetch!(new Request(
        `https://spaces.atmo.garden/xrpc/${method}?${params}`,
        { headers: { authorization: `Bearer ${await token(method)}` } },
      ) as never, env, context());
    };

    const admitted = await check("did:plc:writer", "write");
    expect(admitted.status).toBe(200);
    expect(await admitted.json()).toEqual({ authorized: true });

    const refused = await check("did:plc:reader", "write");
    expect(await refused.json()).toEqual({ authorized: false });

    // Reads never reach the write authorizer, and writes never reach the read
    // authorizer: a reader authorized for the space is not thereby a writer.
    expect(writeChecks).toEqual([
      { userDid: "did:plc:writer", action: "write" },
      { userDid: "did:plc:reader", action: "write" },
    ]);
    expect(readChecks).toEqual([]);

    const read = await check("did:plc:reader", "read");
    expect(await read.json()).toEqual({ authorized: true });
    expect(readChecks).toEqual(["did:plc:reader"]);
    expect(writeChecks).toHaveLength(2);

    const unspecified = await check("did:plc:reader");
    expect(unspecified.status).toBe(400);
  });

  it("denies a write check for a space type Contrail does not manage writes for", async () => {
    const db = createSqliteDatabase(":memory:");
    bindRecordValidationLexicons(projection, lexicons);
    await initSpacesStorage(db, projection);
    await ensureSpaceWatch(db, { spaceUri: space });
    const readChecks: string[] = [];
    const worker = createSpacesWorker({
      projection,
      lexicons,
      service: {
        endpoint: "https://spaces.atmo.garden",
        audience,
        resolver: {
          async resolve(did) {
            return {
              "@context": [],
              id: did,
              verificationMethod: [{
                id: `${did}#atproto`,
                type: "Multikey",
                controller: did,
                publicKeyMultibase: await keypair.exportPublicKey("multikey"),
              }],
            };
          },
        },
      },
      spaceTypes: {
        "garden.atmo.circle": {
          collections: [collection],
          readPolicy: "managing-app",
          // The authority holds the write decision; Contrail is not configured
          // to answer it, so a live space that diverged must not slip through.
          writePolicy: "member-list",
          skey: "self",
        },
      },
      authorization: {
        authorize: (input) => {
          readChecks.push(input.userDid);
          return true;
        },
      },
    });
    const method = "com.atproto.simplespace.checkUserAccess";
    const params = new URLSearchParams({ space, user: "did:plc:reader", access: "write" });
    const response = await worker.fetch!(new Request(
      `https://spaces.atmo.garden/xrpc/${method}?${params}`,
      { headers: { authorization: `Bearer ${await token(method)}` } },
    ) as never, {
      DB: db,
      SPACES_CREDENTIAL_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    } as never, context());
    expect(await response.json()).toEqual({ authorized: false });
    expect(readChecks).toEqual([]);
  });
});
