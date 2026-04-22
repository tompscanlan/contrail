/** Resolve a raw topic request (as given by a caller) to the concrete set of
 *  delivery topics they are authorized to subscribe to.
 *
 *  Rules (v1):
 *    - `space:<uri>`     → allowed iff caller is owner or a member of the space.
 *    - `community:<did>` → expanded to `space:<uri>` for every space in the
 *                          community reachable by the caller (direct grants
 *                          or via delegation). `resolveReachableSpaces`
 *                          already has exactly this semantics.
 *    - `actor:<did>`     → self-only in v1.
 *    - `collection:<nsid>` → rejected unless the deployment opts in
 *                            (not yet implemented). */

import type { StorageAdapter } from "../spaces/types";
import type { CommunityAdapter } from "../community/adapter";
import { resolveReachableSpaces } from "../community/acl";
import { spaceTopic, parseCommunityTopic, parseSpaceTopic } from "./types";

export interface TopicResolutionContext {
  spaces: StorageAdapter;
  /** May be null if the community module is not enabled. */
  community: CommunityAdapter | null;
}

export interface TopicResolution {
  ok: true;
  topics: string[];
}

export interface TopicResolutionError {
  ok: false;
  error: "Forbidden" | "InvalidRequest" | "NotFound" | "NotSupported";
  reason: string;
}

export async function resolveTopicForCaller(
  rawTopic: string,
  callerDid: string,
  ctx: TopicResolutionContext
): Promise<TopicResolution | TopicResolutionError> {
  // space:<uri>
  const spaceUri = parseSpaceTopic(rawTopic);
  if (spaceUri) {
    const space = await ctx.spaces.getSpace(spaceUri);
    if (!space) return { ok: false, error: "NotFound", reason: "space-not-found" };
    if (space.ownerDid === callerDid) return { ok: true, topics: [rawTopic] };
    const member = await ctx.spaces.getMember(spaceUri, callerDid);
    if (!member) return { ok: false, error: "Forbidden", reason: "not-member" };
    return { ok: true, topics: [rawTopic] };
  }

  // community:<did>
  const communityDid = parseCommunityTopic(rawTopic);
  if (communityDid) {
    if (!ctx.community) {
      return { ok: false, error: "NotSupported", reason: "community-module-disabled" };
    }
    const row = await ctx.community.getCommunity(communityDid);
    if (!row) return { ok: false, error: "NotFound", reason: "community-not-found" };
    const reachable = await resolveReachableSpaces(ctx.community, callerDid);
    // Filter to spaces owned by THIS community — reachable may include spaces
    // from other communities via cross-community delegation.
    const ownedList = await ctx.spaces.listSpaces({ ownerDid: communityDid, limit: 1000 });
    const owned: Set<string> = new Set(ownedList.spaces.map((s) => s.uri));
    const topics: string[] = [];
    for (const uri of reachable) {
      if (owned.has(uri)) topics.push(spaceTopic(uri));
    }
    if (topics.length === 0) {
      return { ok: false, error: "Forbidden", reason: "no-reachable-spaces-in-community" };
    }
    return { ok: true, topics };
  }

  // actor:<did> — self-only in v1.
  if (rawTopic.startsWith("actor:")) {
    const did = rawTopic.slice("actor:".length);
    if (did !== callerDid) {
      return { ok: false, error: "Forbidden", reason: "actor-self-only" };
    }
    return { ok: true, topics: [rawTopic] };
  }

  // collection:<nsid> — public firehose, not exposed in v1.
  if (rawTopic.startsWith("collection:")) {
    return { ok: false, error: "NotSupported", reason: "collection-firehose-disabled" };
  }

  return { ok: false, error: "InvalidRequest", reason: "unknown-topic" };
}
