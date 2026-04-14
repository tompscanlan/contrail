import type { Hono, MiddlewareHandler } from "hono";
import type { ContrailConfig, Database } from "../types";
import { HostedAdapter } from "./adapter";
import { checkAccess, resolveCollectionPolicy } from "./acl";
import type { ServiceAuth } from "./auth";
import { createServiceAuthMiddleware } from "./auth";
import { nextTid } from "./tid";
import type { CollectionPolicy, SpaceRow, SpacesConfig, StorageAdapter } from "./types";
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
