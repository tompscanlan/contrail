/**
 * Community blob upload end-to-end (Option A).
 *
 * Pins the custodian blob path: caller's JWT → `$publishers` ACL → encrypted
 * app-password decrypt → PDS session → `com.atproto.repo.uploadBlob` against the
 * **community** PDS → BlobRef valid in the community repo.
 *
 * The decisive proof that the bytes landed in the COMMUNITY repo (not the
 * caller's) is the follow-on `putRecord`: a PDS only accepts a record whose blob
 * refs are present in *that repo's* blob store. So:
 *   1. `community.uploadBlob` returns 200 with `{ blob }` (a real CID).
 *   2. `getBlob(did=communityDid, cid)` on the PDS serves the exact bytes back.
 *   3. `community.putRecord` of an event referencing that blob succeeds — which
 *      is only possible if the blob is in the community repo. (A blob uploaded
 *      to the caller's own repo would make this fail BlobNotFound.)
 *   4. The record is readable from the PDS with the blob ref embedded.
 *
 * Plus: a caller not in $publishers gets 403.
 *
 * Prereqs: `pnpm stack:up`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import type { Client } from "@atcute/client";
import "@atcute/atproto";
import { runPersistent } from "@atmo-dev/contrail";
import { createHandler } from "@atmo-dev/contrail/server";
import { createPostgresDatabase } from "@atmo-dev/contrail/postgres";
import { config as baseConfig } from "../config";
import {
  createTestAccount,
  createIsolatedSchema,
  createDevnetResolver,
  setupCommunityContrail,
  createCaller,
  createAppPasswordFor,
  devnetRewriteFetch,
  getRecordFromPds,
  login,
  mintServiceAuthJwt,
  CONTRAIL_SERVICE_DID,
  PDS_URL,
  type CallAs,
  type TestAccount,
} from "./helpers";

const NS = `${baseConfig.namespace}.community`;
const SPACE_TYPE = "rsvp.atmo.event.space";
const EVENT_NSID = "community.lexicon.calendar.event";
const TEST_MASTER_KEY = new Uint8Array(32).fill(7);

// A real 1x1 transparent PNG. The PDS runs image processing on `image/*`
// blobs (dimension extraction), so a truncated/fake image makes uploadBlob 500
// with "End-Of-Stream" — the bytes must decode as a valid PNG.
const IMAGE_BYTES = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  ),
);

type BlobRef = {
  $type: "blob";
  ref: { $link: string };
  mimeType: string;
  size: number;
};

// Generate a valid, sortable TID rkey (13-char base32-sortable), matching what
// atmo's editor mints client-side before calling putCommunityRecord. The public
// putRecord route is a straight com.atproto.repo.putRecord proxy and requires an
// rkey.
const TID_CHARS = "234567abcdefghijklmnopqrstuvwxyz";
function genTid(): string {
  const micros = BigInt(Date.now()) * 1000n;
  const clockId = BigInt(Math.floor(Math.random() * 1024));
  let n = (micros << 10n) | clockId;
  let s = "";
  for (let i = 0; i < 13; i++) {
    s = TID_CHARS[Number(n & 31n)] + s;
    n >>= 5n;
  }
  return s;
}

describe("community blob upload (custodian → community PDS)", () => {
  let alice: TestAccount; // owner of community spaces (caller)
  let bob: TestAccount; // account adopted as the community
  let charlie: TestAccount; // outsider — no grants on the community

  let aliceClient: Client;
  let charlieClient: Client;
  let bobAppPassword: string;

  let pool: pg.Pool;
  let cleanupSchema: () => Promise<void>;
  let handle: (req: Request) => Promise<Response>;
  let callAs: CallAs;
  let ingestController: AbortController;
  let ingestPromise: Promise<void>;

  let adoptedCommunityDid: string;

  /** POST raw bytes to an XRPC route (callAs only does JSON bodies). */
  async function uploadBlobAs(
    client: Client,
    communityDid: string,
    bytes: Uint8Array,
    contentType = "image/png",
  ): Promise<Response> {
    const token = await mintServiceAuthJwt(client, {
      aud: CONTRAIL_SERVICE_DID,
      lxm: `${NS}.uploadBlob`,
    });
    const url =
      `http://test/xrpc/${NS}.uploadBlob` +
      `?communityDid=${encodeURIComponent(communityDid)}`;
    return handle(
      new Request(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": contentType },
        body: bytes,
      }),
    );
  }

  beforeAll(async () => {
    [alice, bob, charlie] = await Promise.all([
      createTestAccount(),
      createTestAccount(),
      createTestAccount(),
    ]);

    aliceClient = await login(alice);
    charlieClient = await login(charlie);
    bobAppPassword = await createAppPasswordFor(bob);

    const iso = await createIsolatedSchema("test_community_blob_upload");
    pool = iso.pool;
    cleanupSchema = iso.cleanup;
    const db = createPostgresDatabase(pool);

    const contrail = await setupCommunityContrail({
      db,
      baseConfig,
      spaceType: SPACE_TYPE,
      community: {
        serviceDid: CONTRAIL_SERVICE_DID,
        masterKey: TEST_MASTER_KEY,
        resolver: createDevnetResolver(),
        fetch: devnetRewriteFetch,
      },
    });
    await contrail.init();
    handle = createHandler(contrail);
    callAs = createCaller(handle);

    ingestController = new AbortController();
    ingestPromise = runPersistent(db, baseConfig, {
      batchSize: 50,
      flushIntervalMs: 500,
      signal: ingestController.signal,
    });

    const adopt = await callAs(aliceClient, "POST", `${NS}.adopt`, {
      body: { identifier: bob.did, appPassword: bobAppPassword },
    });
    expect(adopt.status, await adopt.clone().text()).toBe(200);
    const data = (await adopt.json()) as { communityDid: string };
    adoptedCommunityDid = data.communityDid;
    expect(adoptedCommunityDid).toBe(bob.did);
  });

  afterAll(async () => {
    ingestController?.abort();
    await ingestPromise?.catch(() => {});
    await cleanupSchema?.();
  });

  it("uploads a blob to the community repo, then references it in a published event", async () => {
    // (1) Upload — Alice is in $publishers via adopt's bootstrap.
    const up = await uploadBlobAs(aliceClient, adoptedCommunityDid, IMAGE_BYTES);
    expect(up.status, await up.clone().text()).toBe(200);
    const { blob } = (await up.json()) as { blob: BlobRef };
    expect(blob.$type).toBe("blob");
    expect(blob.ref.$link).toMatch(/^bafkre/); // raw-leaf CID for the bytes
    const cid = blob.ref.$link;

    // (2) Reference the blob in an event written to the community repo. The PDS
    //     integrity-checks blob refs against the repo's blob store and only
    //     "claims" a staged blob when a record commits it, so this succeeds
    //     only because the blob lives in the COMMUNITY repo — the crux of
    //     Option A. A blob uploaded to Alice's repo would fail BlobNotFound.
    const eventName = `community-blob-event ${Date.now()}`;
    const rkey = genTid();
    const put = await callAs(aliceClient, "POST", `${NS}.putRecord`, {
      body: {
        communityDid: adoptedCommunityDid,
        collection: EVENT_NSID,
        rkey,
        record: {
          $type: EVENT_NSID,
          name: eventName,
          createdAt: new Date().toISOString(),
          startsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
          mode: `${EVENT_NSID}#inperson`,
          status: `${EVENT_NSID}#scheduled`,
          media: [
            {
              role: "thumbnail",
              content: blob,
              aspect_ratio: { width: 1, height: 1 },
            },
          ],
        },
      },
    });
    expect(put.status, await put.clone().text()).toBe(200);
    const out = (await put.json()) as { uri: string; cid: string };
    expect(out.uri).toBe(`at://${adoptedCommunityDid}/${EVENT_NSID}/${rkey}`);

    // (3) The PDS has the record, with the blob ref embedded.
    const pds = await getRecordFromPds(adoptedCommunityDid, EVENT_NSID, rkey);
    expect(pds.status).toBe(200);
    expect(pds.record.name).toBe(eventName);
    expect(pds.record.media[0].content.ref.$link).toBe(cid);

    // (4) Now that a record references it, the PDS serves the exact bytes back
    //     from the COMMUNITY repo via getBlob.
    const blobRes = await fetch(
      `${PDS_URL}/xrpc/com.atproto.sync.getBlob` +
        `?did=${encodeURIComponent(adoptedCommunityDid)}&cid=${encodeURIComponent(cid)}`,
    );
    expect(blobRes.status, await blobRes.clone().text()).toBe(200);
    const served = new Uint8Array(await blobRes.arrayBuffer());
    expect(served.byteLength).toBe(IMAGE_BYTES.byteLength);
  });

  it("rejects a blob upload from a caller not in $publishers", async () => {
    const res = await uploadBlobAs(charlieClient, adoptedCommunityDid, IMAGE_BYTES);
    expect(res.status).toBe(403);
    const data = (await res.json()) as { reason: string };
    expect(data.reason).toBe("not-in-publishers");
  });
});
