/** Realtime module — canonical types + interfaces. See docs/realtime.md. */

/** Discriminated union of every event kind that flows through the PubSub. */
export type RealtimeEvent =
  | {
      topic: string;
      kind: "record.created";
      payload: { spaceUri: string; collection: string; authorDid: string; rkey: string };
      ts: number;
    }
  | {
      topic: string;
      kind: "record.deleted";
      payload: { spaceUri: string; collection: string; authorDid: string; rkey: string };
      ts: number;
    }
  | {
      topic: string;
      kind: "member.added";
      payload: { spaceUri: string; did: string };
      ts: number;
    }
  | {
      topic: string;
      kind: "member.removed";
      payload: { spaceUri: string; did: string };
      ts: number;
    };

export type RealtimeEventKind = RealtimeEvent["kind"];

/** Core pubsub abstraction. Implementations: InMemoryPubSub, DurableObjectPubSub. */
export interface PubSub {
  publish(event: RealtimeEvent): Promise<void>;
  /** Stream events on the topic until the signal aborts (or the iterator is
   *  returned/broken out of). Implementations use a bounded per-subscriber
   *  queue with drop-oldest semantics — a slow subscriber can't stall publishers. */
  subscribe(topic: string, signal?: AbortSignal): AsyncIterable<RealtimeEvent>;
}

// ---- Canonical topic strings -----------------------------------------------
// `community:<did>` is an alias resolved at ticket-mint time to the concrete
// set of `space:<uri>` topics the caller can see; it is never a real delivery
// topic. The other three are real.

export function spaceTopic(uri: string): string {
  return `space:${uri}`;
}

export function communityTopic(did: string): string {
  return `community:${did}`;
}

export function collectionTopic(nsid: string): string {
  return `collection:${nsid}`;
}

export function actorTopic(did: string): string {
  return `actor:${did}`;
}

export function isCommunityTopic(topic: string): boolean {
  return topic.startsWith("community:");
}

export function parseCommunityTopic(topic: string): string | null {
  return isCommunityTopic(topic) ? topic.slice("community:".length) : null;
}

export function parseSpaceTopic(topic: string): string | null {
  return topic.startsWith("space:") ? topic.slice("space:".length) : null;
}

// ---- Config -----------------------------------------------------------------

export interface RealtimeConfig {
  /** Backing pubsub. Default: new InMemoryPubSub() (single-process only). On
   *  Workers, pass `new DurableObjectPubSub(env.REALTIME)`. */
  pubsub?: PubSub;
  /** HMAC secret used to sign subscription tickets. 32 bytes. Accepts raw
   *  Uint8Array or base64 / hex string. Envelope-encrypts nothing — tickets
   *  are integrity-only, not confidential. */
  ticketSecret: Uint8Array | string;
  /** Ticket lifetime in ms. Default 120_000 (2 minutes). */
  ticketTtlMs?: number;
  /** SSE/WS keepalive interval in ms. Default 15_000. */
  keepaliveMs?: number;
  /** Per-subscriber queue bound. Default 1024. Events beyond this are dropped
   *  oldest-first and the subscriber receives a `lag` signal (out of band). */
  queueBound?: number;
}

export const DEFAULT_TICKET_TTL_MS = 120_000;
export const DEFAULT_KEEPALIVE_MS = 15_000;
export const DEFAULT_QUEUE_BOUND = 1024;
