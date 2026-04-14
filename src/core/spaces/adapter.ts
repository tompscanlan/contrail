import type { Database } from "../types";
import type {
  AppPolicy,
  CollectionCount,
  CollectionPolicy,
  CreateInviteInput,
  InviteRow,
  ListOptions,
  ListResult,
  ListSpacesOptions,
  SpaceMemberRow,
  SpaceRow,
  StorageAdapter,
  StoredRecord,
} from "./types";

function parseJson<T>(value: unknown): T | null {
  if (value == null) return null;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }
  return value as T;
}

function toNum(v: unknown): number {
  return typeof v === "string" ? Number(v) : (v as number);
}

function mapSpaceRow(row: any): SpaceRow {
  return {
    uri: row.uri,
    ownerDid: row.owner_did,
    type: row.type,
    key: row.key,
    serviceDid: row.service_did,
    memberListRef: row.member_list_ref ?? null,
    appPolicyRef: row.app_policy_ref ?? null,
    policy: parseJson<Record<string, CollectionPolicy>>(row.policy),
    appPolicy: parseJson<AppPolicy>(row.app_policy),
    createdAt: toNum(row.created_at),
    deletedAt: row.deleted_at == null ? null : toNum(row.deleted_at),
  };
}

function mapMemberRow(row: any): SpaceMemberRow {
  return {
    spaceUri: row.space_uri,
    did: row.did,
    perms: row.perms,
    addedAt: toNum(row.added_at),
    addedBy: row.added_by ?? null,
  };
}

function mapInviteRow(row: any): InviteRow {
  return {
    tokenHash: row.token_hash,
    spaceUri: row.space_uri,
    perms: row.perms,
    expiresAt: row.expires_at == null ? null : toNum(row.expires_at),
    maxUses: row.max_uses == null ? null : Number(row.max_uses),
    usedCount: Number(row.used_count),
    createdBy: row.created_by,
    createdAt: toNum(row.created_at),
    revokedAt: row.revoked_at == null ? null : toNum(row.revoked_at),
    note: row.note ?? null,
  };
}

function mapRecordRow(row: any): StoredRecord {
  return {
    spaceUri: row.space_uri,
    collection: row.collection,
    authorDid: row.author_did,
    rkey: row.rkey,
    cid: row.cid ?? null,
    record: parseJson<Record<string, unknown>>(row.record) ?? {},
    createdAt: toNum(row.created_at),
  };
}

export class HostedAdapter implements StorageAdapter {
  constructor(private readonly db: Database) {}

  async createSpace(space: Omit<SpaceRow, "createdAt" | "deletedAt">): Promise<SpaceRow> {
    const now = Date.now();
    await this.db
      .prepare(
        `INSERT INTO spaces (uri, owner_did, type, key, service_did, member_list_ref, app_policy_ref, policy, app_policy, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        space.uri,
        space.ownerDid,
        space.type,
        space.key,
        space.serviceDid,
        space.memberListRef,
        space.appPolicyRef,
        space.policy ? JSON.stringify(space.policy) : null,
        space.appPolicy ? JSON.stringify(space.appPolicy) : null,
        now
      )
      .run();
    return { ...space, createdAt: now, deletedAt: null };
  }

  async getSpace(spaceUri: string): Promise<SpaceRow | null> {
    const row = await this.db
      .prepare(`SELECT * FROM spaces WHERE uri = ? AND deleted_at IS NULL`)
      .bind(spaceUri)
      .first<any>();
    return row ? mapSpaceRow(row) : null;
  }

  async listSpaces(options: ListSpacesOptions): Promise<{ spaces: SpaceRow[]; cursor?: string }> {
    const limit = Math.min(options.limit ?? 50, 200);
    const clauses: string[] = ["s.deleted_at IS NULL"];
    const params: any[] = [];
    let join = "";

    if (options.type) {
      clauses.push("s.type = ?");
      params.push(options.type);
    }
    if (options.ownerDid) {
      clauses.push("s.owner_did = ?");
      params.push(options.ownerDid);
    }
    if (options.memberDid) {
      join = "JOIN spaces_members m ON m.space_uri = s.uri";
      clauses.push("m.did = ?");
      params.push(options.memberDid);
    }
    if (options.cursor) {
      clauses.push("s.created_at < ?");
      params.push(Number(options.cursor));
    }

    const sql = `SELECT s.* FROM spaces s ${join}
      WHERE ${clauses.join(" AND ")}
      ORDER BY s.created_at DESC
      LIMIT ?`;
    params.push(limit + 1);

    const { results } = await this.db.prepare(sql).bind(...params).all<any>();
    const spaces = results.map(mapSpaceRow);
    let cursor: string | undefined;
    if (spaces.length > limit) {
      const next = spaces.pop()!;
      cursor = String(next.createdAt);
    }
    return { spaces, cursor };
  }

  async deleteSpace(spaceUri: string): Promise<void> {
    await this.db
      .prepare(`UPDATE spaces SET deleted_at = ? WHERE uri = ?`)
      .bind(Date.now(), spaceUri)
      .run();
  }

  async updateSpacePolicy(spaceUri: string, policy: Record<string, CollectionPolicy>): Promise<void> {
    await this.db
      .prepare(`UPDATE spaces SET policy = ? WHERE uri = ?`)
      .bind(JSON.stringify(policy), spaceUri)
      .run();
  }

  async updateSpaceAppPolicy(spaceUri: string, appPolicy: AppPolicy): Promise<void> {
    await this.db
      .prepare(`UPDATE spaces SET app_policy = ? WHERE uri = ?`)
      .bind(JSON.stringify(appPolicy), spaceUri)
      .run();
  }

  async addMember(spaceUri: string, did: string, perms: string, addedBy: string | null): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO spaces_members (space_uri, did, perms, added_at, added_by)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (space_uri, did) DO UPDATE SET perms = excluded.perms`
      )
      .bind(spaceUri, did, perms, Date.now(), addedBy)
      .run();
  }

  async removeMember(spaceUri: string, did: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM spaces_members WHERE space_uri = ? AND did = ?`)
      .bind(spaceUri, did)
      .run();
  }

  async getMember(spaceUri: string, did: string): Promise<SpaceMemberRow | null> {
    const row = await this.db
      .prepare(`SELECT * FROM spaces_members WHERE space_uri = ? AND did = ?`)
      .bind(spaceUri, did)
      .first<any>();
    return row ? mapMemberRow(row) : null;
  }

  async listMembers(spaceUri: string): Promise<SpaceMemberRow[]> {
    const { results } = await this.db
      .prepare(`SELECT * FROM spaces_members WHERE space_uri = ? ORDER BY added_at ASC`)
      .bind(spaceUri)
      .all<any>();
    return results.map(mapMemberRow);
  }

  async createInvite(input: CreateInviteInput): Promise<InviteRow> {
    const now = Date.now();
    await this.db
      .prepare(
        `INSERT INTO spaces_invites (token_hash, space_uri, perms, expires_at, max_uses, used_count, created_by, created_at, note)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`
      )
      .bind(
        input.tokenHash,
        input.spaceUri,
        input.perms,
        input.expiresAt,
        input.maxUses,
        input.createdBy,
        now,
        input.note
      )
      .run();
    return {
      tokenHash: input.tokenHash,
      spaceUri: input.spaceUri,
      perms: input.perms,
      expiresAt: input.expiresAt,
      maxUses: input.maxUses,
      usedCount: 0,
      createdBy: input.createdBy,
      createdAt: now,
      revokedAt: null,
      note: input.note,
    };
  }

  async listInvites(
    spaceUri: string,
    options: { includeRevoked?: boolean } = {}
  ): Promise<InviteRow[]> {
    const sql = options.includeRevoked
      ? `SELECT * FROM spaces_invites WHERE space_uri = ? ORDER BY created_at DESC`
      : `SELECT * FROM spaces_invites WHERE space_uri = ? AND revoked_at IS NULL ORDER BY created_at DESC`;
    const { results } = await this.db.prepare(sql).bind(spaceUri).all<any>();
    return results.map(mapInviteRow);
  }

  async revokeInvite(tokenHash: string): Promise<boolean> {
    const res = await this.db
      .prepare(`UPDATE spaces_invites SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL`)
      .bind(Date.now(), tokenHash)
      .run();
    const changes = (res as any)?.changes ?? (res as any)?.meta?.changes ?? 0;
    return Number(changes) > 0;
  }

  async redeemInvite(tokenHash: string, now: number): Promise<InviteRow | null> {
    // Atomic: increment used_count only if the invite is usable right now.
    const res = await this.db
      .prepare(
        `UPDATE spaces_invites
         SET used_count = used_count + 1
         WHERE token_hash = ?
           AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > ?)
           AND (max_uses IS NULL OR used_count < max_uses)`
      )
      .bind(tokenHash, now)
      .run();
    const changes = (res as any)?.changes ?? (res as any)?.meta?.changes ?? 0;
    if (Number(changes) === 0) return null;

    const row = await this.db
      .prepare(`SELECT * FROM spaces_invites WHERE token_hash = ?`)
      .bind(tokenHash)
      .first<any>();
    return row ? mapInviteRow(row) : null;
  }

  async putRecord(record: StoredRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO spaces_records (space_uri, collection, author_did, rkey, cid, record, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (space_uri, collection, author_did, rkey) DO UPDATE SET
           cid = excluded.cid, record = excluded.record`
      )
      .bind(
        record.spaceUri,
        record.collection,
        record.authorDid,
        record.rkey,
        record.cid,
        JSON.stringify(record.record),
        record.createdAt
      )
      .run();
  }

  async getRecord(
    spaceUri: string,
    collection: string,
    authorDid: string,
    rkey: string
  ): Promise<StoredRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM spaces_records
         WHERE space_uri = ? AND collection = ? AND author_did = ? AND rkey = ?`
      )
      .bind(spaceUri, collection, authorDid, rkey)
      .first<any>();
    return row ? mapRecordRow(row) : null;
  }

  async listRecords(
    spaceUri: string,
    collection: string,
    options: ListOptions = {}
  ): Promise<ListResult> {
    const limit = Math.min(options.limit ?? 50, 200);
    const clauses: string[] = ["space_uri = ?", "collection = ?"];
    const params: any[] = [spaceUri, collection];

    if (options.byUser) {
      clauses.push("author_did = ?");
      params.push(options.byUser);
    }
    if (options.cursor) {
      clauses.push("created_at < ?");
      params.push(Number(options.cursor));
    }

    const sql = `SELECT * FROM spaces_records
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT ?`;
    params.push(limit + 1);

    const { results } = await this.db.prepare(sql).bind(...params).all<any>();
    const records = results.map(mapRecordRow);
    let cursor: string | undefined;
    if (records.length > limit) {
      const next = records.pop()!;
      cursor = String(next.createdAt);
    }
    return { records, cursor };
  }

  async deleteRecord(
    spaceUri: string,
    collection: string,
    authorDid: string,
    rkey: string
  ): Promise<void> {
    await this.db
      .prepare(
        `DELETE FROM spaces_records
         WHERE space_uri = ? AND collection = ? AND author_did = ? AND rkey = ?`
      )
      .bind(spaceUri, collection, authorDid, rkey)
      .run();
  }

  async listCollections(
    spaceUri: string,
    options: { byUser?: string } = {}
  ): Promise<CollectionCount[]> {
    const clauses: string[] = ["space_uri = ?"];
    const params: any[] = [spaceUri];
    if (options.byUser) {
      clauses.push("author_did = ?");
      params.push(options.byUser);
    }
    const sql = `SELECT collection, COUNT(*) AS count
      FROM spaces_records
      WHERE ${clauses.join(" AND ")}
      GROUP BY collection`;
    const { results } = await this.db.prepare(sql).bind(...params).all<any>();
    return results.map((r) => ({ collection: r.collection, count: Number(r.count) }));
  }
}
