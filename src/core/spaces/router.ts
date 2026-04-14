import type { Hono, MiddlewareHandler } from "hono";
import type { ContrailConfig, Database } from "../types";
import { HostedAdapter } from "./adapter";
import { checkAccess, resolveCollectionPolicy } from "./acl";
import type { ServiceAuth } from "./auth";
import { createServiceAuthMiddleware } from "./auth";
import { nextTid } from "./tid";
import { generateInviteToken, hashInviteToken } from "./invite-token";
import type { CollectionPolicy, InviteRow, SpaceRow, SpacesConfig, StorageAdapter } from "./types";
import type { Did } from "@atcute/lexicons";

const SPACE = "tools.atmo.space";

export interface SpacesRoutesOptions {
  /** Provide a custom middleware (e.g. for tests). If omitted and spaces.resolver is set, a real one is built. */
  authMiddleware?: MiddlewareHandler;
  /** Storage adapter override. Defaults to HostedAdapter(db). */
  adapter?: StorageAdapter;
}

export function registerSpacesRoutes(
  app: Hono,
  db: Database,
  config: ContrailConfig,
  options: SpacesRoutesOptions = {}
): void {
  const spacesConfig = config.spaces;
  if (!spacesConfig) return;

  const adapter = options.adapter ?? new HostedAdapter(db);
  const auth = options.authMiddleware ?? buildAuthMiddleware(spacesConfig);
  if (!auth) return; // no resolver configured — spaces are effectively disabled

  // Read endpoints
  app.get(`/xrpc/${SPACE}.getSpace`, auth, async (c) => {
    const uri = c.req.query("uri");
    if (!uri) return c.json({ error: "InvalidRequest", message: "uri required" }, 400);
    const space = await adapter.getSpace(uri);
    if (!space) return c.json({ error: "NotFound" }, 404);

    const sa = getAuth(c);
    const isOwner = sa.issuer === space.ownerDid;
    const member = isOwner ? null : await adapter.getMember(uri, sa.issuer);
    if (!isOwner && !member) {
      return c.json({ error: "Forbidden", reason: "not-member" }, 403);
    }
    return c.json({ space: publicSpaceView(space, isOwner) });
  });

  app.get(`/xrpc/${SPACE}.listRecords`, auth, async (c) => {
    const sa = getAuth(c);
    const spaceUri = c.req.query("spaceUri");
    const collection = c.req.query("collection");
    if (!spaceUri || !collection) {
      return c.json({ error: "InvalidRequest", message: "spaceUri and collection required" }, 400);
    }
    const space = await adapter.getSpace(spaceUri);
    if (!space) return c.json({ error: "NotFound" }, 404);

    const member = await adapter.getMember(spaceUri, sa.issuer);
    const result = checkAccess({
      op: "read",
      collection,
      space,
      callerDid: sa.issuer,
      member,
      clientId: sa.clientId,
      config: spacesConfig,
    });
    if (!result.allow) {
      return c.json({ error: "Forbidden", reason: result.reason }, 403);
    }

    // member-own: force caller-only filter
    const byUserParam = c.req.query("byUser") ?? undefined;
    const byUser =
      result.policy.read === "member-own" ? sa.issuer : byUserParam;

    const list = await adapter.listRecords(spaceUri, collection, {
      byUser,
      cursor: c.req.query("cursor") ?? undefined,
      limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
    });
    return c.json(list);
  });

  app.get(`/xrpc/${SPACE}.getRecord`, auth, async (c) => {
    const sa = getAuth(c);
    const spaceUri = c.req.query("spaceUri");
    const collection = c.req.query("collection");
    const author = c.req.query("author");
    const rkey = c.req.query("rkey");
    if (!spaceUri || !collection || !author || !rkey) {
      return c.json({ error: "InvalidRequest", message: "spaceUri, collection, author, rkey required" }, 400);
    }
    const space = await adapter.getSpace(spaceUri);
    if (!space) return c.json({ error: "NotFound" }, 404);

    const member = await adapter.getMember(spaceUri, sa.issuer);
    const result = checkAccess({
      op: "read",
      collection,
      space,
      callerDid: sa.issuer,
      member,
      clientId: sa.clientId,
      targetAuthorDid: author,
      config: spacesConfig,
    });
    if (!result.allow) return c.json({ error: "Forbidden", reason: result.reason }, 403);

    const record = await adapter.getRecord(spaceUri, collection, author, rkey);
    if (!record) return c.json({ error: "NotFound" }, 404);
    return c.json({ record });
  });

  // Write endpoints
  app.post(`/xrpc/${SPACE}.putRecord`, auth, async (c) => {
    const sa = getAuth(c);
    const body = (await c.req.json().catch(() => null)) as
      | { spaceUri?: string; collection?: string; rkey?: string; record?: Record<string, unknown> }
      | null;
    if (!body?.spaceUri || !body.collection || !body.record) {
      return c.json({ error: "InvalidRequest", message: "spaceUri, collection, record required" }, 400);
    }
    const space = await adapter.getSpace(body.spaceUri);
    if (!space) return c.json({ error: "NotFound" }, 404);

    const member = await adapter.getMember(body.spaceUri, sa.issuer);
    const result = checkAccess({
      op: "write",
      collection: body.collection,
      space,
      callerDid: sa.issuer,
      member,
      clientId: sa.clientId,
      config: spacesConfig,
    });
    if (!result.allow) return c.json({ error: "Forbidden", reason: result.reason }, 403);

    const rkey = body.rkey ?? nextTid();
    const now = Date.now();
    await adapter.putRecord({
      spaceUri: body.spaceUri,
      collection: body.collection,
      authorDid: sa.issuer,
      rkey,
      cid: null,
      record: body.record,
      createdAt: now,
    });
    return c.json({ rkey, authorDid: sa.issuer, createdAt: now });
  });

  // Admin endpoints
  app.post(`/xrpc/${SPACE}.admin.createSpace`, auth, async (c) => {
    const sa = getAuth(c);
    const body = (await c.req.json().catch(() => ({}))) as {
      type?: string;
      key?: string;
      policy?: Record<string, CollectionPolicy>;
      appPolicy?: SpaceRow["appPolicy"];
      memberListRef?: string;
      appPolicyRef?: string;
    };

    const type = body.type ?? spacesConfig.type;
    const key = body.key ?? nextTid();
    const uri = `at://${sa.issuer}/${type}/${key}`;

    const existing = await adapter.getSpace(uri);
    if (existing) return c.json({ error: "AlreadyExists", uri }, 409);

    const space = await adapter.createSpace({
      uri,
      ownerDid: sa.issuer,
      type,
      key,
      serviceDid: spacesConfig.serviceDid,
      memberListRef: body.memberListRef ?? null,
      appPolicyRef: body.appPolicyRef ?? null,
      policy: body.policy ?? null,
      appPolicy: body.appPolicy ?? spacesConfig.defaultAppPolicy ?? null,
    });
    await adapter.addMember(uri, sa.issuer, "owner", sa.issuer);

    return c.json({ space: publicSpaceView(space, true) });
  });

  // Invites
  app.post(`/xrpc/${SPACE}.invite.create`, auth, async (c) => {
    const sa = getAuth(c);
    const body = (await c.req.json().catch(() => null)) as
      | { spaceUri?: string; perms?: string; expiresAt?: number; maxUses?: number; note?: string }
      | null;
    if (!body?.spaceUri) {
      return c.json({ error: "InvalidRequest", message: "spaceUri required" }, 400);
    }
    const space = await adapter.getSpace(body.spaceUri);
    if (!space) return c.json({ error: "NotFound" }, 404);
    if (space.ownerDid !== sa.issuer) {
      return c.json({ error: "Forbidden", reason: "not-owner" }, 403);
    }

    const token = generateInviteToken();
    const tokenHash = await hashInviteToken(token);
    const invite = await adapter.createInvite({
      spaceUri: body.spaceUri,
      tokenHash,
      perms: body.perms ?? "member",
      expiresAt: body.expiresAt ?? null,
      maxUses: body.maxUses ?? null,
      createdBy: sa.issuer,
      note: body.note ?? null,
    });
    return c.json({ token, invite: publicInviteView(invite) });
  });

  app.post(`/xrpc/${SPACE}.invite.redeem`, auth, async (c) => {
    const sa = getAuth(c);
    const body = (await c.req.json().catch(() => null)) as { token?: string } | null;
    if (!body?.token) {
      return c.json({ error: "InvalidRequest", message: "token required" }, 400);
    }
    const tokenHash = await hashInviteToken(body.token);
    const invite = await adapter.redeemInvite(tokenHash, Date.now());
    if (!invite) {
      return c.json({ error: "InvalidInvite", reason: "expired-revoked-or-exhausted" }, 400);
    }
    await adapter.addMember(invite.spaceUri, sa.issuer, invite.perms, invite.createdBy);
    return c.json({ spaceUri: invite.spaceUri, perms: invite.perms });
  });

  app.get(`/xrpc/${SPACE}.invite.list`, auth, async (c) => {
    const sa = getAuth(c);
    const spaceUri = c.req.query("spaceUri");
    if (!spaceUri) return c.json({ error: "InvalidRequest", message: "spaceUri required" }, 400);
    const space = await adapter.getSpace(spaceUri);
    if (!space) return c.json({ error: "NotFound" }, 404);
    if (space.ownerDid !== sa.issuer) {
      return c.json({ error: "Forbidden", reason: "not-owner" }, 403);
    }
    const includeRevoked = c.req.query("includeRevoked") === "true";
    const invites = await adapter.listInvites(spaceUri, { includeRevoked });
    return c.json({ invites: invites.map(publicInviteView) });
  });

  app.post(`/xrpc/${SPACE}.invite.revoke`, auth, async (c) => {
    const sa = getAuth(c);
    const body = (await c.req.json().catch(() => null)) as
      | { spaceUri?: string; tokenHash?: string }
      | null;
    if (!body?.spaceUri || !body.tokenHash) {
      return c.json({ error: "InvalidRequest", message: "spaceUri and tokenHash required" }, 400);
    }
    const space = await adapter.getSpace(body.spaceUri);
    if (!space) return c.json({ error: "NotFound" }, 404);
    if (space.ownerDid !== sa.issuer) {
      return c.json({ error: "Forbidden", reason: "not-owner" }, 403);
    }
    const ok = await adapter.revokeInvite(body.tokenHash);
    return c.json({ ok });
  });

  app.post(`/xrpc/${SPACE}.admin.addMember`, auth, async (c) => {
    const sa = getAuth(c);
    const body = (await c.req.json().catch(() => null)) as
      | { spaceUri?: string; did?: string; perms?: string }
      | null;
    if (!body?.spaceUri || !body.did) {
      return c.json({ error: "InvalidRequest", message: "spaceUri and did required" }, 400);
    }
    const space = await adapter.getSpace(body.spaceUri);
    if (!space) return c.json({ error: "NotFound" }, 404);
    if (space.ownerDid !== sa.issuer) {
      return c.json({ error: "Forbidden", reason: "not-owner" }, 403);
    }
    await adapter.addMember(body.spaceUri, body.did, body.perms ?? "member", sa.issuer);
    return c.json({ ok: true });
  });
}

function buildAuthMiddleware(spaces: SpacesConfig): MiddlewareHandler | null {
  if (!spaces.resolver) return null;
  return createServiceAuthMiddleware({
    serviceDid: spaces.serviceDid as Did,
    resolver: spaces.resolver,
  });
}

function getAuth(c: Parameters<MiddlewareHandler>[0]): ServiceAuth {
  const auth = c.get("serviceAuth") as ServiceAuth | undefined;
  if (!auth) throw new Error("service auth not set");
  return auth;
}

function publicInviteView(invite: InviteRow) {
  return {
    tokenHash: invite.tokenHash,
    spaceUri: invite.spaceUri,
    perms: invite.perms,
    expiresAt: invite.expiresAt,
    maxUses: invite.maxUses,
    usedCount: invite.usedCount,
    createdBy: invite.createdBy,
    createdAt: invite.createdAt,
    revokedAt: invite.revokedAt,
    note: invite.note,
  };
}

function publicSpaceView(space: SpaceRow, forOwner: boolean) {
  return {
    uri: space.uri,
    ownerDid: space.ownerDid,
    type: space.type,
    key: space.key,
    serviceDid: space.serviceDid,
    memberListRef: space.memberListRef,
    appPolicyRef: space.appPolicyRef,
    createdAt: space.createdAt,
    ...(forOwner ? { policy: space.policy, appPolicy: space.appPolicy } : {}),
  };
}

export { resolveCollectionPolicy };
