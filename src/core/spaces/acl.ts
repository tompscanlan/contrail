import type {
  AppPolicy,
  CollectionPolicy,
  SpaceMemberRow,
  SpaceRow,
  SpacesConfig,
} from "./types";

export type AclOp = "read" | "write" | "delete";

export interface AclInput {
  op: AclOp;
  collection: string;
  space: SpaceRow;
  callerDid: string;
  /** Membership row for the caller (or null). Owner does not require a row. */
  member: SpaceMemberRow | null;
  /** OAuth client_id of the app calling on caller's behalf, for app policy checks. */
  clientId?: string;
  /** For per-record ops (get/delete), the record's author DID. */
  targetAuthorDid?: string;
  /** The service's configured defaults, used when the space has no override. */
  config: Pick<SpacesConfig, "defaultPolicies" | "defaultPolicy">;
}

export type AclResult =
  | { allow: true; policy: CollectionPolicy }
  | { allow: false; reason: AclDenyReason; policy?: CollectionPolicy };

export type AclDenyReason =
  | "no-policy"
  | "not-member"
  | "not-owner"
  | "not-own-record"
  | "app-not-allowed"
  | "unknown-op";

/** Resolve the effective policy for a given collection in a given space. */
export function resolveCollectionPolicy(
  space: SpaceRow,
  collection: string,
  config: Pick<SpacesConfig, "defaultPolicies" | "defaultPolicy">
): CollectionPolicy | null {
  return (
    space.policy?.[collection] ??
    config.defaultPolicies?.[collection] ??
    config.defaultPolicy ??
    null
  );
}

/** Check whether the caller's app is permitted to act in this space. */
export function checkAppPolicy(
  appPolicy: AppPolicy | null,
  clientId: string | undefined
): boolean {
  if (!appPolicy) return true; // no policy = allow-all
  const listed = clientId ? appPolicy.apps.includes(clientId) : false;
  if (appPolicy.mode === "allow") return !listed; // apps[] is a denylist
  return listed; // mode === "deny": apps[] is an allowlist
}

const isOwner = (space: SpaceRow, did: string) => space.ownerDid === did;
const isMember = (space: SpaceRow, member: SpaceMemberRow | null, did: string) =>
  isOwner(space, did) || member != null;

export function checkAccess(input: AclInput): AclResult {
  const policy = resolveCollectionPolicy(input.space, input.collection, input.config);
  if (!policy) return { allow: false, reason: "no-policy" };

  if (!checkAppPolicy(input.space.appPolicy, input.clientId)) {
    return { allow: false, reason: "app-not-allowed", policy };
  }

  if (input.op === "read") {
    switch (policy.read) {
      case "owner":
        return isOwner(input.space, input.callerDid)
          ? { allow: true, policy }
          : { allow: false, reason: "not-owner", policy };
      case "member":
        return isMember(input.space, input.member, input.callerDid)
          ? { allow: true, policy }
          : { allow: false, reason: "not-member", policy };
      case "member-own":
        if (!isMember(input.space, input.member, input.callerDid)) {
          return { allow: false, reason: "not-member", policy };
        }
        if (input.targetAuthorDid && input.targetAuthorDid !== input.callerDid) {
          return { allow: false, reason: "not-own-record", policy };
        }
        return { allow: true, policy };
    }
  }

  if (input.op === "write") {
    switch (policy.write) {
      case "owner":
        return isOwner(input.space, input.callerDid)
          ? { allow: true, policy }
          : { allow: false, reason: "not-owner", policy };
      case "member":
        return isMember(input.space, input.member, input.callerDid)
          ? { allow: true, policy }
          : { allow: false, reason: "not-member", policy };
    }
  }

  if (input.op === "delete") {
    if (isOwner(input.space, input.callerDid)) return { allow: true, policy };
    if (!isMember(input.space, input.member, input.callerDid)) {
      return { allow: false, reason: "not-member", policy };
    }
    if (input.targetAuthorDid && input.targetAuthorDid !== input.callerDid) {
      return { allow: false, reason: "not-own-record", policy };
    }
    return { allow: true, policy };
  }

  return { allow: false, reason: "unknown-op" };
}
