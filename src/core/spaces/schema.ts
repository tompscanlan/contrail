import type { Database } from "../types";
import { getDialect } from "../dialect";

export function buildSpacesSchema(db: Database): string[] {
  const dialect = getDialect(db);
  return [
    `CREATE TABLE IF NOT EXISTS spaces (
      uri TEXT PRIMARY KEY,
      owner_did TEXT NOT NULL,
      type TEXT NOT NULL,
      key TEXT NOT NULL,
      service_did TEXT NOT NULL,
      member_list_ref TEXT,
      app_policy_ref TEXT,
      policy ${dialect.recordColumnType},
      app_policy ${dialect.recordColumnType},
      created_at ${dialect.bigintType} NOT NULL,
      deleted_at ${dialect.bigintType}
    )`,
    `CREATE INDEX IF NOT EXISTS idx_spaces_owner ON spaces(owner_did)`,
    `CREATE INDEX IF NOT EXISTS idx_spaces_type ON spaces(type)`,

    `CREATE TABLE IF NOT EXISTS spaces_records (
      space_uri TEXT NOT NULL,
      collection TEXT NOT NULL,
      author_did TEXT NOT NULL,
      rkey TEXT NOT NULL,
      cid TEXT,
      record ${dialect.recordColumnType},
      created_at ${dialect.bigintType} NOT NULL,
      PRIMARY KEY (space_uri, collection, author_did, rkey)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_spaces_records_space_col ON spaces_records(space_uri, collection, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_spaces_records_space_author ON spaces_records(space_uri, author_did, created_at DESC)`,

    `CREATE TABLE IF NOT EXISTS spaces_members (
      space_uri TEXT NOT NULL,
      did TEXT NOT NULL,
      perms TEXT NOT NULL,
      added_at ${dialect.bigintType} NOT NULL,
      added_by TEXT,
      PRIMARY KEY (space_uri, did)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_spaces_members_did ON spaces_members(did)`,

    `CREATE TABLE IF NOT EXISTS spaces_invites (
      token_hash TEXT PRIMARY KEY,
      space_uri TEXT NOT NULL,
      perms TEXT NOT NULL,
      expires_at ${dialect.bigintType},
      max_uses INTEGER,
      used_count INTEGER NOT NULL DEFAULT 0,
      created_by TEXT NOT NULL,
      created_at ${dialect.bigintType} NOT NULL,
      revoked_at ${dialect.bigintType},
      note TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_spaces_invites_space ON spaces_invites(space_uri, created_at DESC)`,
  ];
}

export async function initSpacesSchema(db: Database): Promise<void> {
  const stmts = buildSpacesSchema(db);
  await db.batch(stmts.map((s) => db.prepare(s)));
}
