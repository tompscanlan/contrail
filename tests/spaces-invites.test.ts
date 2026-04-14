import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { createSqliteDatabase } from "../src/adapters/sqlite";
import { initSchema } from "../src/core/db/schema";
import { createApp } from "../src/core/router";
import { resolveConfig } from "../src/core/types";
import type { ContrailConfig } from "../src/core/types";
import { generateInviteToken, hashInviteToken } from "../src/core/spaces/invite-token";

const ALICE = "did:plc:alice";
const BOB = "did:plc:bob";
const CHARLIE = "did:plc:charlie";

const CONFIG: ContrailConfig = {
  namespace: "test.spaces",
  collections: {},
  spaces: {
    type: "tools.atmo.event.space",
    serviceDid: "did:web:test.example#svc",
    defaultPolicies: {
      "app.event.message": { read: "member", write: "member" },
    },
  },
};

function fakeAuth(): MiddlewareHandler {
  return async (c, next) => {
    const did = c.req.header("X-Test-Did");
    if (!did) return c.json({ error: "AuthRequired" }, 401);
    c.set("serviceAuth", {
      issuer: did,
      audience: CONFIG.spaces!.serviceDid,
      lxm: undefined,
    });
    await next();
  };
}

function call(app: Hono, method: string, path: string, did: string, body?: any) {
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        "X-Test-Did": did,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  );
}

describe("invite token helpers", () => {
  it("generates random tokens of consistent length", () => {
    const a = generateInviteToken();
    const b = generateInviteToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(40);
    expect(/^[A-Za-z0-9_-]+$/.test(a)).toBe(true);
  });

  it("hashes deterministically", async () => {
    const token = generateInviteToken();
    const h1 = await hashInviteToken(token);
    const h2 = await hashInviteToken(token);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("invite e2e", () => {
  let app: Hono;
  let spaceUri: string;

  beforeAll(async () => {
    const db = createSqliteDatabase(":memory:");
    const resolved = resolveConfig(CONFIG);
    await initSchema(db, resolved);
    app = createApp(db, resolved, { spaces: { authMiddleware: fakeAuth() } });

    const res = await call(app, "POST", "/xrpc/tools.atmo.space.admin.createSpace", ALICE, {
      key: "party",
    });
    spaceUri = ((await res.json()) as any).space.uri;
  });

  it("non-owner cannot create an invite", async () => {
    const res = await call(app, "POST", "/xrpc/tools.atmo.space.invite.create", BOB, {
      spaceUri,
    });
    expect(res.status).toBe(403);
  });

  it("owner creates an invite and Bob redeems it to become a member", async () => {
    const create = await call(app, "POST", "/xrpc/tools.atmo.space.invite.create", ALICE, {
      spaceUri,
      perms: "attendee",
    });
    expect(create.status).toBe(200);
    const { token, invite } = (await create.json()) as any;
    expect(token).toBeTruthy();
    expect(invite.tokenHash).toBeTruthy();
    expect(invite.spaceUri).toBe(spaceUri);
    expect(invite.usedCount).toBe(0);

    const redeem = await call(app, "POST", "/xrpc/tools.atmo.space.invite.redeem", BOB, { token });
    expect(redeem.status).toBe(200);
    const body = (await redeem.json()) as any;
    expect(body.spaceUri).toBe(spaceUri);
    expect(body.perms).toBe("attendee");

    // Bob is now a member — can write a message
    const put = await call(app, "POST", "/xrpc/tools.atmo.space.putRecord", BOB, {
      spaceUri,
      collection: "app.event.message",
      record: { text: "yay" },
    });
    expect(put.status).toBe(200);
  });

  it("single-use invite rejects second redemption", async () => {
    const create = await call(app, "POST", "/xrpc/tools.atmo.space.invite.create", ALICE, {
      spaceUri, maxUses: 1,
    });
    const { token } = (await create.json()) as any;

    const first = await call(app, "POST", "/xrpc/tools.atmo.space.invite.redeem", BOB, { token });
    expect(first.status).toBe(200);

    const second = await call(app, "POST", "/xrpc/tools.atmo.space.invite.redeem", CHARLIE, { token });
    expect(second.status).toBe(400);
    const body = (await second.json()) as any;
    expect(body.reason).toBe("expired-revoked-or-exhausted");
  });

  it("expired invite rejects redemption", async () => {
    const create = await call(app, "POST", "/xrpc/tools.atmo.space.invite.create", ALICE, {
      spaceUri, expiresAt: Date.now() - 1000,
    });
    const { token } = (await create.json()) as any;
    const res = await call(app, "POST", "/xrpc/tools.atmo.space.invite.redeem", CHARLIE, { token });
    expect(res.status).toBe(400);
  });

  it("revoked invite rejects redemption and list filters it by default", async () => {
    const create = await call(app, "POST", "/xrpc/tools.atmo.space.invite.create", ALICE, {
      spaceUri,
    });
    const { token, invite } = (await create.json()) as any;

    const revoke = await call(app, "POST", "/xrpc/tools.atmo.space.invite.revoke", ALICE, {
      spaceUri, tokenHash: invite.tokenHash,
    });
    expect(revoke.status).toBe(200);
    expect(((await revoke.json()) as any).ok).toBe(true);

    const tryRedeem = await call(app, "POST", "/xrpc/tools.atmo.space.invite.redeem", CHARLIE, { token });
    expect(tryRedeem.status).toBe(400);

    const listActive = await call(app, "GET", `/xrpc/tools.atmo.space.invite.list?spaceUri=${encodeURIComponent(spaceUri)}`, ALICE);
    const activeHashes = ((await listActive.json()) as any).invites.map((i: any) => i.tokenHash);
    expect(activeHashes).not.toContain(invite.tokenHash);

    const listAll = await call(app, "GET", `/xrpc/tools.atmo.space.invite.list?spaceUri=${encodeURIComponent(spaceUri)}&includeRevoked=true`, ALICE);
    const allHashes = ((await listAll.json()) as any).invites.map((i: any) => i.tokenHash);
    expect(allHashes).toContain(invite.tokenHash);
  });

  it("non-owner cannot list or revoke invites", async () => {
    const listRes = await call(app, "GET", `/xrpc/tools.atmo.space.invite.list?spaceUri=${encodeURIComponent(spaceUri)}`, BOB);
    expect(listRes.status).toBe(403);

    const revokeRes = await call(app, "POST", "/xrpc/tools.atmo.space.invite.revoke", BOB, {
      spaceUri, tokenHash: "nonexistent",
    });
    expect(revokeRes.status).toBe(403);
  });
});
