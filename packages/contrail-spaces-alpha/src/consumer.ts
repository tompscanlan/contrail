import { formatServiceOAuthScope } from "@atmo-dev/contrail";
import {
  formatSpaceRecordUri,
  formatSpaceUri,
  parseSpaceUri,
} from "./uri";

export interface AuthenticatedPdsSession {
  did: string;
  handle(pathname: string, init?: RequestInit): Promise<Response>;
}

export interface SpacePermissionScopeInput {
  type: string;
  authority?: string;
  skey?: string;
  collections: readonly string[];
  actions?: readonly ("read" | "create" | "update" | "delete")[];
  manage?: readonly ("create" | "update" | "delete")[];
}

/** Build the current alpha permission token without requiring consumer apps to
 * install the alpha scope parser alongside @svelte-atproto/oauth. */
export function formatSpacePermissionScope(input: SpacePermissionScopeInput): string {
  const params = new URLSearchParams();
  params.set("authority", input.authority ?? "*");
  if (input.skey) params.set("skey", input.skey);
  for (const collection of input.collections) params.append("collection", collection);
  for (const action of input.actions ?? ["read", "create", "update", "delete"]) {
    params.append("action", action);
  }
  for (const manage of input.manage ?? ["create", "update", "delete"]) {
    params.append("manage", manage);
  }
  return `space:${input.type}?${params.toString()}`;
}

export interface SpacesOAuthScopeInput {
  collections: readonly string[];
  spaceType: string;
  skey?: string;
}

/** OAuth scopes for an integrated application. User-facing Contrail calls are
 * authenticated by the application's own session rather than AT service JWTs. */
export function spacesIntegratedOAuthScopes(input: SpacesOAuthScopeInput): string[] {
  return [
    "atproto",
    formatSpacePermissionScope({
      type: input.spaceType,
      skey: input.skey,
      collections: input.collections,
    }),
  ];
}

/** OAuth scopes for the optional standalone service-auth adapter. */
export function spacesConsumerOAuthScopes(input: SpacesOAuthScopeInput & {
  audience: string;
  namespace: string;
}): string[] {
  const methods = [
    `${input.namespace}.authorizeSpace`,
    `${input.namespace}.syncSpace`,
    `${input.namespace}.listSpaces`,
    `${input.namespace}.subscribeSpace`,
    ...input.collections.flatMap((collection) => {
      const short = collection.split(".").at(-1)!;
      return [
        `${input.namespace}.${short}.listSpaceRecords`,
        `${input.namespace}.${short}.getSpaceRecord`,
      ];
    }),
  ];
  return [
    ...spacesIntegratedOAuthScopes(input),
    formatServiceOAuthScope(input.audience as never, methods),
  ];
}

async function readJson<T>(response: Response): Promise<T> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  if (!response.ok) {
    const object = body && typeof body === "object" ? body as Record<string, unknown> : {};
    const code = typeof object.error === "string" ? object.error : `HTTP${response.status}`;
    const message = typeof object.message === "string" ? object.message : code;
    throw new Error(message);
  }
  return body as T;
}

async function pdsQuery<T>(
  session: AuthenticatedPdsSession,
  method: string,
  params: Record<string, string>,
): Promise<T> {
  const query = new URLSearchParams(params);
  const response = await session.handle(`/xrpc/${method}?${query}`, {
    headers: { accept: "application/json" },
  });
  return readJson<T>(response);
}

async function pdsProcedure<T>(
  session: AuthenticatedPdsSession,
  method: string,
  body: Record<string, unknown>,
): Promise<T> {
  const response = await session.handle(`/xrpc/${method}`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return readJson<T>(response);
}

export type SimpleSpacePolicyInput =
  | { kind: "public" }
  | { kind: "member-list" }
  | { kind: "managing-app"; managingApp: string };

function simpleSpacePolicy(input: SimpleSpacePolicyInput): Record<string, string> {
  if (input.kind === "public") {
    return { $type: "com.atproto.simplespace.defs#publicPolicy" };
  }
  if (input.kind === "member-list") {
    return { $type: "com.atproto.simplespace.defs#memberListPolicy" };
  }
  return {
    $type: "com.atproto.simplespace.defs#managingAppPolicy",
    managingApp: input.managingApp,
  };
}

export function createSpace(
  session: AuthenticatedPdsSession,
  input: {
    type: string;
    skey?: string;
    /** Who the authority lets read the space. */
    readPolicy: SimpleSpacePolicyInput;
    /** Whose independent writes the authority tracks and forwards. */
    writePolicy: SimpleSpacePolicyInput;
  },
): Promise<{ uri: string }> {
  return pdsProcedure(session, "com.atproto.simplespace.createSpace", {
    type: input.type,
    ...(input.skey ? { skey: input.skey } : {}),
    readPolicy: simpleSpacePolicy(input.readPolicy),
    writePolicy: simpleSpacePolicy(input.writePolicy),
    appAccess: { $type: "com.atproto.simplespace.defs#open" },
  });
}

export function getSimpleSpace(
  session: AuthenticatedPdsSession,
  space: string,
): Promise<{
  uri: string;
  readPolicy?: { $type?: string; managingApp?: string };
  writePolicy?: { $type?: string; managingApp?: string };
  appAccess?: { $type?: string };
}> {
  parseSpaceUri(space);
  return pdsQuery(session, "com.atproto.simplespace.getSpace", { space });
}

/** Replace either policy wholesale. An omitted policy is left unchanged, so a
 * caller that means to change only reads cannot silently reset writes. */
export function updateSimpleSpacePolicies(
  session: AuthenticatedPdsSession,
  space: string,
  policies: {
    readPolicy?: SimpleSpacePolicyInput;
    writePolicy?: SimpleSpacePolicyInput;
  },
): Promise<Record<string, never>> {
  parseSpaceUri(space);
  if (!policies.readPolicy && !policies.writePolicy) {
    throw new TypeError("updateSimpleSpacePolicies requires readPolicy, writePolicy, or both");
  }
  return pdsProcedure(session, "com.atproto.simplespace.updateSpace", {
    space,
    ...(policies.readPolicy
      ? { readPolicy: simpleSpacePolicy(policies.readPolicy) }
      : {}),
    ...(policies.writePolicy
      ? { writePolicy: simpleSpacePolicy(policies.writePolicy) }
      : {}),
  });
}

/** Add a member to the space's member list, or replace their access. Both
 * flags are required: the member-list read policy and the member-list write
 * policy consult them independently. */
export function putSimpleSpaceMember(
  session: AuthenticatedPdsSession,
  space: string,
  member: { did: string; read: boolean; write: boolean },
): Promise<Record<string, never>> {
  parseSpaceUri(space);
  return pdsProcedure(session, "com.atproto.simplespace.putMember", {
    space,
    did: member.did,
    read: member.read,
    write: member.write,
  });
}

export function removeSimpleSpaceMember(
  session: AuthenticatedPdsSession,
  space: string,
  did: string,
): Promise<Record<string, never>> {
  parseSpaceUri(space);
  return pdsProcedure(session, "com.atproto.simplespace.removeMember", { space, did });
}

export function listSimpleSpaceMembers(
  session: AuthenticatedPdsSession,
  input: { space: string; cursor?: string; limit?: number },
): Promise<{
  members: Array<{ did: string; read: boolean; write: boolean }>;
  cursor?: string;
}> {
  parseSpaceUri(input.space);
  return pdsQuery(session, "com.atproto.simplespace.listMembers", {
    space: input.space,
    ...(input.cursor ? { cursor: input.cursor } : {}),
    ...(input.limit ? { limit: String(input.limit) } : {}),
  });
}

/** Create a record in the caller's own repo inside the space.
 *
 * `validate` defaults to `false`, and deliberately stays `false` by default:
 * the PDS refuses `validate: true` for a collection whose Lexicon it does not
 * host. Measured against pds.opnmt.net on 2026-09-13, `validate: true` on a
 * third-party collection answers
 * `400 {"error":"InvalidRequest","message":"Unknown lexicon type: net.openmeet.probe.note"}`,
 * while the same write with `validate: false` answers 200. The PDS does
 * validate collections it knows, so a caller writing a collection the
 * authority PDS hosts can opt in with `validate: true` and read
 * `validationStatus` to see what the server actually checked. */
export function createSpaceRecord(
  session: AuthenticatedPdsSession,
  input: {
    space: string;
    collection: string;
    record: Record<string, unknown>;
    rkey?: string;
    /** Defaults to `false`; see above before turning it on. */
    validate?: boolean;
  },
): Promise<{
  uri: string;
  cid: string;
  /** Present when the PDS reports what it checked: `valid` for a Lexicon it
   * hosts and enforced, `unknown` when validation was skipped. */
  validationStatus?: "valid" | "unknown";
}> {
  parseSpaceUri(input.space);
  return pdsProcedure(session, "com.atproto.space.createRecord", {
    space: input.space,
    repo: session.did,
    collection: input.collection,
    ...(input.rkey ? { rkey: input.rkey } : {}),
    validate: input.validate ?? false,
    record: input.record,
  });
}

/** Delete a record from the caller's own repo inside the space. Succeeds
 * whether or not the record was present. `com.atproto.space.deleteRecord`
 * declares no `validate` input and an empty output, so unlike
 * `createSpaceRecord` there is no validation option or status to surface. */
export function deleteSpaceRecord(
  session: AuthenticatedPdsSession,
  input: { space: string; collection: string; rkey: string },
): Promise<Record<string, never>> {
  parseSpaceUri(input.space);
  return pdsProcedure(session, "com.atproto.space.deleteRecord", {
    space: input.space,
    repo: session.did,
    collection: input.collection,
    rkey: input.rkey,
  });
}

export async function getDelegationToken(
  session: AuthenticatedPdsSession,
  space: string,
): Promise<string> {
  parseSpaceUri(space);
  const result = await pdsQuery<{ token: string }>(
    session,
    "com.atproto.space.getDelegationToken",
    { space },
  );
  if (!result.token) throw new Error("PDS returned no delegation token");
  return result.token;
}

export async function getServiceAuthToken(
  session: AuthenticatedPdsSession,
  input: { audience: string; method: string },
): Promise<string> {
  const result = await pdsQuery<{ token: string }>(
    session,
    "com.atproto.server.getServiceAuth",
    { aud: input.audience, lxm: input.method },
  );
  if (!result.token) throw new Error("PDS returned no service-auth token");
  return result.token;
}

const runtimeFetch: typeof globalThis.fetch = (input, init) =>
  globalThis.fetch(input, init);

export interface SpacesProviderClientOptions {
  endpoint: string;
  audience: string;
  namespace: string;
  session: AuthenticatedPdsSession;
  fetch?: typeof globalThis.fetch;
}

export class SpacesProviderClient {
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(readonly options: SpacesProviderClientOptions) {
    this.fetchImpl = options.fetch ?? runtimeFetch;
  }

  private async call<T>(
    method: string,
    init: RequestInit & { params?: URLSearchParams },
  ): Promise<T> {
    const token = await getServiceAuthToken(this.options.session, {
      audience: this.options.audience,
      method,
    });
    const url = new URL(`/xrpc/${method}`, this.options.endpoint);
    if (init.params) url.search = init.params.toString();
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    headers.set("authorization", `Bearer ${token}`);
    const response = await this.fetchImpl(url, { ...init, headers });
    return readJson<T>(response);
  }

  async authorizeSpace(
    space: string,
    options: { rediscover?: boolean } = {},
  ): Promise<{ space: string; generation: number; accessExpiresAt: string }> {
    const delegation = await getDelegationToken(this.options.session, space);
    return this.call(`${this.options.namespace}.authorizeSpace`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ space, delegation, rediscover: options.rediscover }),
    });
  }

  syncSpace(space: string, repo?: string): Promise<{ queued: boolean }> {
    return this.call(`${this.options.namespace}.syncSpace`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ space, repo }),
    });
  }

  subscribeSpace(space: string): Promise<{ url: string; expiresAt: string }> {
    return this.call(`${this.options.namespace}.subscribeSpace`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ space }),
    });
  }

  listSpaces(options: { cursor?: string; limit?: number } = {}): Promise<{
    spaces: Array<{ uri: string; authorityDid: string; type: string }>;
    cursor?: string;
    truncated: boolean;
  }> {
    const params = new URLSearchParams();
    if (options.cursor) params.set("cursor", options.cursor);
    if (options.limit) params.set("limit", String(options.limit));
    return this.call(`${this.options.namespace}.listSpaces`, {
      method: "GET",
      params,
    });
  }

  listSpaceRecords<T = Record<string, unknown>>(input: {
    space: string;
    collection: string;
    limit?: number;
    cursor?: string;
    search?: string;
    did?: string;
    filters?: Record<string, string>;
  }): Promise<{
    records: T[];
    cursor?: string;
    references: Record<string, Record<string, unknown>>;
  }> {
    const short = input.collection.split(".").at(-1)!;
    const params = new URLSearchParams({ space: input.space });
    if (input.limit) params.set("limit", String(input.limit));
    if (input.cursor) params.set("cursor", input.cursor);
    if (input.search) params.set("search", input.search);
    if (input.did) params.set("did", input.did);
    for (const [key, value] of Object.entries(input.filters ?? {})) {
      params.set(key, value);
    }
    return this.call(
      `${this.options.namespace}.${short}.listSpaceRecords`,
      { method: "GET", params },
    );
  }

  getSpaceRecord<T = Record<string, unknown>>(input: {
    space: string;
    collection: string;
    uri: string;
  }): Promise<{ record: T; references: Record<string, Record<string, unknown>> }> {
    const short = input.collection.split(".").at(-1)!;
    const params = new URLSearchParams({ space: input.space, uri: input.uri });
    return this.call(
      `${this.options.namespace}.${short}.getSpaceRecord`,
      { method: "GET", params },
    );
  }
}

export { formatSpaceRecordUri, formatSpaceUri };
