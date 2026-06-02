import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { createSqliteDatabase } from "@atmo-dev/contrail/sqlite";
import { initSchema } from "@atmo-dev/contrail";
import { createApp } from "@atmo-dev/contrail";
import { resolveConfig } from "@atmo-dev/contrail";
import type { ContrailConfig, Database } from "@atmo-dev/contrail";
import { createCommunityIntegration } from "../src/integration";

const ALICE = "did:plc:alice";
const CHARLIE = "did:plc:charlie";
const COMMUNITY_DID = "did:plc:pubcomm";
const PDS_ENDPOINT = "https://pds.example";

const MASTER_KEY = new Uint8Array(32).fill(42);

const BLOB_CID = "bafkreiuploadedblobcid";

/** Records every PDS call so tests can assert proxying happened. Captures raw
 *  body bytes for uploadBlob (which is NOT JSON) so we can verify byte-for-byte
 *  passthrough + the forwarded content-type and authorization. */
const pdsCalls: Array<{
  url: string;
  contentType: string | null;
  authorization: string | null;
  rawLen: number;
}> = [];

const CONFIG: ContrailConfig = {
  namespace: "test.comm",
  collections: { message: { collection: "app.event.message" } },
  spaces: {
    authority: {
      type: "tools.atmo.event.space",
      serviceDid: "did:web:test.example#svc",
    },
    recordHost: {},
  },
  community: {
    masterKey: MASTER_KEY,
    fetch: mockFetch,
    resolver: mockResolver(),
  },
};

function mockResolver(): any {
  return {
    resolve: async (did: string) => {
      if (did !== COMMUNITY_DID) throw new Error("unknown did");
      return {
        id: did,
        service: [
          {
            id: "#atproto_pds",
            type: "AtprotoPersonalDataServer",
            serviceEndpoint: PDS_ENDPOINT,
          },
        ],
      };
    },
  };
}

async function mockFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const headers = new Headers((init?.headers as HeadersInit) ?? {});

  if (url.endsWith("/xrpc/com.atproto.server.createSession")) {
    const body = init?.body ? JSON.parse(init.body as string) : {};
    pdsCalls.push({ url, contentType: null, authorization: null, rawLen: 0 });
    if (body.password === "correct-pw") {
      return new Response(
        JSON.stringify({ accessJwt: "a.b.c", refreshJwt: "r.r.r", did: COMMUNITY_DID }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response(JSON.stringify({ error: "AuthFailed" }), { status: 401 });
  }

  if (url.endsWith("/xrpc/com.atproto.repo.uploadBlob")) {
    // Body is raw image bytes, NOT JSON. Measure them to prove passthrough.
    const raw = init?.body;
    let rawLen = 0;
    if (raw instanceof Uint8Array) rawLen = raw.byteLength;
    else if (raw instanceof ArrayBuffer) rawLen = raw.byteLength;
    else if (typeof raw === "string") rawLen = raw.length;
    pdsCalls.push({
      url,
      contentType: headers.get("content-type"),
      authorization: headers.get("authorization"),
      rawLen,
    });
    return new Response(
      JSON.stringify({
        blob: {
          $type: "blob",
          ref: { $link: BLOB_CID },
          mimeType: headers.get("content-type") ?? "application/octet-stream",
          size: rawLen,
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }

  return new Response("not found", { status: 404 });
}

function fakeAuth(): MiddlewareHandler {
  return async (c, next) => {
    const did = c.req.header("X-Test-Did");
    if (!did) return c.json({ error: "AuthRequired" }, 401);
    c.set("serviceAuth", {
      issuer: did,
      audience: CONFIG.spaces!.authority!.serviceDid,
      lxm: undefined,
    });
    await next();
  };
}

async function makeApp(): Promise<{ app: Hono; db: Database }> {
  const db = createSqliteDatabase(":memory:");
  const resolved = resolveConfig(CONFIG);
  const community = createCommunityIntegration({ db, config: resolved });
  await initSchema(db, resolved, { extraSchemas: [community.applySchema] });
  const app = createApp(db, resolved, {
    spaces: { authMiddleware: fakeAuth() },
    community,
  });
  return { app, db };
}

async function adopt(app: Hono, caller: string, password: string) {
  const res = await app.fetch(
    new Request("http://localhost/xrpc/test.comm.community.adopt", {
      method: "POST",
      headers: { "X-Test-Did": caller, "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: COMMUNITY_DID, appPassword: password }),
    })
  );
  expect(res.status).toBe(200);
}

/** POST raw bytes to the uploadBlob route with communityDid in the query. */
async function uploadBlob(
  app: Hono,
  did: string,
  communityDid: string,
  bytes: Uint8Array,
  contentType = "image/png"
): Promise<Response> {
  return await app.fetch(
    new Request(
      `http://localhost/xrpc/test.comm.community.uploadBlob?communityDid=${encodeURIComponent(
        communityDid
      )}`,
      {
        method: "POST",
        headers: { "X-Test-Did": did, "Content-Type": contentType },
        body: bytes as unknown as BodyInit,
      }
    )
  );
}

describe("community.uploadBlob — custodian blob proxy (Option A)", () => {
  let app: Hono;
  const imageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

  beforeAll(async () => {
    ({ app } = await makeApp());
    // adopt bootstraps Alice as owner of $publishers.
    await adopt(app, ALICE, "correct-pw");
  });

  it("proxies raw bytes to the community PDS and returns a community-repo BlobRef", async () => {
    const before = pdsCalls.length;
    const res = await uploadBlob(app, ALICE, COMMUNITY_DID, imageBytes);
    expect(res.status).toBe(200);

    const body = (await res.json()) as any;
    expect(body.blob).toBeDefined();
    expect(body.blob.$type).toBe("blob");
    expect(body.blob.ref.$link).toBe(BLOB_CID);

    const newCalls = pdsCalls.slice(before);
    // Authenticated against the community via a session...
    expect(
      newCalls.some((c) => c.url.endsWith("/xrpc/com.atproto.server.createSession"))
    ).toBe(true);
    // ...then proxied the bytes to the community PDS uploadBlob with the session
    // bearer + the original image content-type + the exact byte length.
    const up = newCalls.find((c) => c.url.endsWith("/xrpc/com.atproto.repo.uploadBlob"));
    expect(up).toBeDefined();
    expect(up!.url.startsWith(PDS_ENDPOINT)).toBe(true);
    expect(up!.authorization).toBe("Bearer a.b.c");
    expect(up!.contentType).toBe("image/png");
    expect(up!.rawLen).toBe(imageBytes.byteLength);
  });

  it("rejects a caller who is not in $publishers", async () => {
    const res = await uploadBlob(app, CHARLIE, COMMUNITY_DID, imageBytes);
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).reason).toBe("not-in-publishers");
  });

  it("requires communityDid", async () => {
    const res = await app.fetch(
      new Request("http://localhost/xrpc/test.comm.community.uploadBlob", {
        method: "POST",
        headers: { "X-Test-Did": ALICE, "Content-Type": "image/png" },
        body: imageBytes as unknown as BodyInit,
      })
    );
    expect(res.status).toBe(400);
  });
});
