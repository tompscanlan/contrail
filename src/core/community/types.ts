import type { Database } from "../types";
import type { DidDocumentResolver } from "@atcute/identity-resolver";

/** Access level a subject (did or group-space) has on a given space.
 *  Levels are totally ordered. Higher levels include lower levels' powers.
 *  See docs/community.md for the exact semantics. */
export type AccessLevel = "member" | "manager" | "admin" | "owner";

export const ACCESS_LEVELS: readonly AccessLevel[] = [
  "member",
  "manager",
  "admin",
  "owner",
] as const;

export function rankOf(level: AccessLevel): number {
  return ACCESS_LEVELS.indexOf(level);
}

export function isAccessLevel(v: unknown): v is AccessLevel {
  return typeof v === "string" && ACCESS_LEVELS.includes(v as AccessLevel);
}

export type CommunityMode = "adopt" | "mint";

export interface CommunityConfig {
  /** Service DID for JWT verification. Falls back to spaces.serviceDid when both modules are enabled. */
  serviceDid?: string;
  /** PLC directory host for minted communities. */
  plcDirectory?: string;
  /** Master key for envelope-encrypting stored credentials (app passwords, signing keys, rotation keys).
   *  Accepts a raw Uint8Array (preferred) or a base64/hex string that decodes to 32 bytes. */
  masterKey: Uint8Array | string;
  /** Optional override for DID resolution (used during adopt to resolve identifier → DID → PDS). */
  resolver?: DidDocumentResolver;
  /** Optional override for the fetch implementation (useful for tests). */
  fetch?: typeof fetch;
}

export interface CommunityRow {
  did: string;
  mode: CommunityMode;
  // adopt-mode fields
  pdsEndpoint: string | null;
  appPasswordEncrypted: Uint8Array | null;
  identifier: string | null;
  // mint-mode fields (Stage 4)
  signingKeyEncrypted: Uint8Array | null;
  rotationKeyEncrypted: Uint8Array | null;
  // common
  createdBy: string;
  createdAt: number;
  deletedAt: number | null;
}

export interface AccessLevelRow {
  spaceUri: string;
  subjectDid: string | null;
  subjectSpaceUri: string | null;
  accessLevel: AccessLevel;
  grantedBy: string;
  grantedAt: number;
}

/** Key prefix for reserved community-owned spaces. */
export const RESERVED_KEYS = ["$admin", "$publishers"] as const;
export type ReservedKey = (typeof RESERVED_KEYS)[number];

export function isReservedKey(key: string): key is ReservedKey {
  return (RESERVED_KEYS as readonly string[]).includes(key);
}

export interface AdapterContext {
  db: Database;
}
