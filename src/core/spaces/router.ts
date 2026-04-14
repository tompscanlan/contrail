import type { Hono, MiddlewareHandler } from "hono";
import type { ContrailConfig, Database } from "../types";
import { HostedAdapter } from "./adapter";
import { checkAccess } from "./acl";
import type { ServiceAuth } from "./auth";
import { buildVerifier, createServiceAuthMiddleware } from "./auth";
import { nextTid } from "./tid";
import { generateInviteToken, hashInviteToken } from "./invite-token";
import type { InviteRow, MemberPerm, SpaceRow, SpacesConfig, StorageAdapter } from "./types";
import type { Did } from "@atcute/lexicons";

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
  options: SpacesRoutesOptions = {},
  ctx?: { adapter: StorageAdapter; verifier: import("@atcute/xrpc-server/auth").ServiceJwtVerifier } | null
): void {
  const spacesConfig = config.spaces;
  if (!spacesConfig) return;

  const adapter = options.adapter ?? ctx?.adapter ?? new HostedAdapter(db, config);
  const auth =
    options.authMiddleware ??
    (ctx ? createServiceAuthMiddleware(ctx.verifier) : buildAuthMiddleware(spacesConfig));

  /** Space endpoints are emitted per-deployment under the configured namespace;
   *  the deployment owns and publishes its own lexicons. The library ships
   *  templates at `lexicons/tools/atmo/space/*` that the generator instantiates
   *  under `<ns>.space.*`. */
  const SPACE = `${config.namespace}.space`;

  // Read endpoints
  app.get(`/xrpc/${SPACE}.listSpaces`, auth, async (c) => {
    const sa = getAuth(c);
    const scope = c.req.query("scope") ?? "member"; // "member" | "owner"
    const type = c.req.query("type") ?? undefined;
    const cursor = c.req.query("cursor") ?? undefined;
    const limit = c.req.query("limit") ? Number(c.req.query("limit")) : undefined;

    const opts: Parameters<typeof adapter.listSpaces>[0] = { type, cursor, limit };
    if (scope === "owner") opts.ownerDid = sa.issuer;
    else opts.memberDid = sa.issuer;

    const result = await adapter.listSpaces(opts);
    return c.json({
      spaces: result.spaces.map((s) => publicSpaceView(s, s.ownerDid === sa.issuer)),
      cursor: result.cursor,
    });
  });

  app.get(`/xrpc/${SPACE}.listMembers`, auth, async (c) => {
    const sa = getAuth(c);
    const spaceUri = c.req.query("spaceUri");
    if (!spaceUri) return c.json({ error: "InvalidRequest", message: "spaceUri required" }, 400);
    const space = await adapter.getSpace(spaceUri);
    if (!space) return c.json({ error: "NotFound" }, 404);

    const isOwner = space.ownerDid === sa.issuer;
    const member = isOwner ? null : await adapter.getMember(spaceUri, sa.issuer);
    if (!isOwner && !member) {
      return c.json({ error: "Forbidden", reason: "not-member" }, 403);
    }
    const members = await adapter.listMembers(spaceUri);
    return c.json({ members });
  });

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
      space,
      callerDid: sa.issuer,
      member,
      clientId: sa.clientId,
    });
    if (!result.allow) {
      return c.json({ error: "Forbidden", reason: result.reason }, 403);
    }

    const list = await adapter.listRecords(spaceUri, collection, {
      byUser: c.req.query("byUser") ?? undefined,
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
      space,
      callerDid: sa.issuer,
      member,
      clientId: sa.clientId,
      targetAuthorDid: author,
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
      space,
      callerDid: sa.issuer,
      member,
      clientId: sa.clientId,
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

  app.post(`/xrpc/${SPACE}.deleteRecord`, auth, async (c) => {
    const sa = getAuth(c);
    const body = (await c.req.json().catch(() => null)) as
      | { spaceUri?: string; collection?: string; rkey?: string }
      | null;
    if (!body?.spaceUri || !body.collection || !body.rkey) {
      return c.json({ error: "InvalidRequest", message: "spaceUri, collection, rkey required" }, 400);
    }
    const space = await adapter.getSpace(body.spaceUri);
    if (!space) return c.json({ error: "NotFound" }, 404);

    const member = await adapter.getMember(body.spaceUri, sa.issuer);
    const result = checkAccess({
      op: "delete",
      space,
      callerDid: sa.issuer,
      member,
      clientId: sa.clientId,
      targetAuthorDid: sa.issuer,
    });
    if (!result.allow) return c.json({ error: "Forbidden", reason: result.reason }, 403);

    await adapter.deleteRecord(body.spaceUri, body.collection, sa.issuer, body.rkey);
    return c.json({ ok: true });
  });

  // Admin endpoints
  app.post(`/xrpc/${SPACE}.admin.createSpace`, auth, async (c) => {
    const sa = getAuth(c);
    const body = (await c.req.json().catch(() => ({}))) as {
      type?: string;
      key?: string;
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
      appPolicy: body.appPolicy ?? spacesConfig.defaultAppPolicy ?? null,
    });
    // Owner is implicit; we still write a row so membership queries are uniform.
    await adapter.addMember(uri, sa.issuer, "write", sa.issuer);

    return c.json({ space: publicSpaceView(space, true) });
  });

  // Invites
  app.post(`/xrpc/${SPACE}.invite.create`, auth, async (c) => {
    const sa = getAuth(c);
    const body = (await c.req.json().catch(() => null)) as
      | { spaceUri?: string; perms?: MemberPerm; expiresAt?: number; maxUses?: number; note?: string }
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
      perms: body.perms ?? "write",
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
      | { spaceUri?: string; did?: string; perms?: MemberPerm }
      | null;
    if (!body?.spaceUri || !body.did) {
      return c.json({ error: "InvalidRequest", message: "spaceUri and did required" }, 400);
    }
    const space = await adapter.getSpace(body.spaceUri);
    if (!space) return c.json({ error: "NotFound" }, 404);
    if (space.ownerDid !== sa.issuer) {
      return c.json({ error: "Forbidden", reason: "not-owner" }, 403);
    }
    await adapter.addMember(body.spaceUri, body.did, body.perms ?? "write", sa.issuer);
    return c.json({ ok: true });
  });

  app.post(`/xrpc/${SPACE}.admin.removeMember`, auth, async (c) => {
    const sa = getAuth(c);
    const body = (await c.req.json().catch(() => null)) as
      | { spaceUri?: string; did?: string }
      | null;
    if (!body?.spaceUri || !body.did) {
      return c.json({ error: "InvalidRequest", message: "spaceUri and did required" }, 400);
    }
    const space = await adapter.getSpace(body.spaceUri);
    if (!space) return c.json({ error: "NotFound" }, 404);
    if (space.ownerDid !== sa.issuer) {
      return c.json({ error: "Forbidden", reason: "not-owner" }, 403);
    }
    if (body.did === space.ownerDid) {
      return c.json({ error: "InvalidRequest", reason: "cannot-remove-owner" }, 400);
    }
    await adapter.removeMember(body.spaceUri, body.did);
    return c.json({ ok: true });
  });
}

function buildAuthMiddleware(spaces: SpacesConfig): MiddlewareHandler {
  const verifier = buildVerifier(spaces);
  return createServiceAuthMiddleware(verifier);
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
    ...(forOwner ? { appPolicy: space.appPolicy } : {}),
  };
}

