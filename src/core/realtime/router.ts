/** Realtime XRPC routes: ticket mint + subscribe (SSE | WS). */

import type { Context, Hono, MiddlewareHandler } from "hono";
import type { ContrailConfig } from "../types";
import type { ServiceAuth } from "../spaces/auth";
import type { StorageAdapter } from "../spaces/types";
import type { CommunityAdapter } from "../community/adapter";
import { InMemoryPubSub } from "./in-memory";
import { TicketSigner } from "./ticket";
import { sseResponse } from "./sse";
import { pumpWebSocket, type WebSocketLike } from "./websocket";
import { mergeAsyncIterables } from "./merge";
import { resolveTopicForCaller } from "./resolve";
import type { PubSub, RealtimeEvent } from "./types";
import { DEFAULT_TICKET_TTL_MS, DEFAULT_KEEPALIVE_MS } from "./types";

export interface RealtimeRoutesOptions {
  /** Required: auth middleware for `<ns>.realtime.ticket` (JWT required).
   *  The subscribe endpoint uses the *ticket* path primarily, so it does not
   *  require this middleware — but bots can subscribe with Authorization
   *  header, in which case this middleware is used as a fallback. */
  authMiddleware: MiddlewareHandler;
  pubsub?: PubSub;
}

/** WebSocketPair exists on Cloudflare Workers; on Node/Bun it's absent.
 *  When absent, a platform-provided WebSocket accept hook is used instead. */
interface WebSocketPairCtor {
  new (): { 0: WebSocketLike & { accept?: () => void }; 1: WebSocketLike & { accept?: () => void } };
}

export function registerRealtimeRoutes(
  app: Hono,
  config: ContrailConfig,
  spaces: StorageAdapter,
  community: CommunityAdapter | null,
  options: RealtimeRoutesOptions
): void {
  const cfg = config.realtime;
  if (!cfg) return;

  const pubsub: PubSub = options.pubsub ?? cfg.pubsub ?? new InMemoryPubSub({ queueBound: cfg.queueBound });
  const signer = new TicketSigner(cfg.ticketSecret);
  const ticketTtl = cfg.ticketTtlMs ?? DEFAULT_TICKET_TTL_MS;
  const keepaliveMs = cfg.keepaliveMs ?? DEFAULT_KEEPALIVE_MS;

  const NS = `${config.namespace}.realtime`;

  // POST /<ns>.realtime.ticket — { topic } → { ticket, topics, expiresAt }
  app.post(`/xrpc/${NS}.ticket`, options.authMiddleware, async (c) => {
    const sa = getAuth(c);
    const body = (await c.req.json().catch(() => null)) as { topic?: string } | null;
    if (!body?.topic) {
      return c.json({ error: "InvalidRequest", message: "topic required" }, 400);
    }
    const resolved = await resolveTopicForCaller(body.topic, sa.issuer, { spaces, community });
    if (!resolved.ok) {
      const status = resolved.error === "NotFound" ? 404 : resolved.error === "Forbidden" ? 403 : 400;
      return c.json({ error: resolved.error, reason: resolved.reason }, status);
    }
    const ticket = await signer.sign({
      topics: resolved.topics,
      did: sa.issuer,
      ttlMs: ticketTtl,
    });
    return c.json({
      ticket,
      topics: resolved.topics,
      expiresAt: Date.now() + ticketTtl,
    });
  });

  // GET /<ns>.realtime.subscribe — SSE or WS, driven by ?ticket= or JWT.
  app.get(`/xrpc/${NS}.subscribe`, async (c) => {
    const url = new URL(c.req.url);
    const ticketParam = url.searchParams.get("ticket");
    const collectionFilter = url.searchParams.get("collection");

    let callerDid: string;
    let topics: string[];

    if (ticketParam) {
      const payload = await signer.verify(ticketParam);
      if (!payload) {
        return c.json({ error: "AuthRequired", reason: "invalid-or-expired-ticket" }, 401);
      }
      callerDid = payload.did;
      topics = payload.topics;
      // Optional: narrow to topics the query explicitly requests.
      const requested = url.searchParams.get("topic");
      if (requested) {
        if (!payload.topics.includes(requested)) {
          return c.json({ error: "Forbidden", reason: "topic-not-in-ticket" }, 403);
        }
        topics = [requested];
      }
    } else {
      // JWT path for server-side bots. Requires the auth middleware to have
      // run and attached `serviceAuth` to the context — so we invoke it
      // inline.
      const runAuth = options.authMiddleware;
      let authed = false;
      await runAuth(c, async () => {
        authed = true;
      });
      if (!authed) return c.res; // middleware already responded with 401
      const sa = getAuth(c);
      callerDid = sa.issuer;
      const topic = url.searchParams.get("topic");
      if (!topic) {
        return c.json({ error: "InvalidRequest", message: "topic required" }, 400);
      }
      const resolved = await resolveTopicForCaller(topic, callerDid, { spaces, community });
      if (!resolved.ok) {
        const status = resolved.error === "NotFound" ? 404 : resolved.error === "Forbidden" ? 403 : 400;
        return c.json({ error: resolved.error, reason: resolved.reason }, status);
      }
      topics = resolved.topics;
    }

    if (topics.length === 0) {
      return c.json({ error: "InvalidRequest", reason: "no-topics" }, 400);
    }

    // Build the merged iterable, with an inline filter that closes the stream
    // on a matching `member.removed` event (self-kick on revocation).
    const ac = new AbortController();
    const signals: AbortSignal[] = [ac.signal];
    const reqSignal = c.req.raw.signal;
    if (reqSignal) signals.push(reqSignal);
    const combined = anySignal(signals);

    const sources = topics.map((t) => pubsub.subscribe(t, combined));
    const merged = withSelfKickAndFilter(
      mergeAsyncIterables(sources, combined),
      callerDid,
      collectionFilter,
      ac
    );

    // Content negotiation: Upgrade: websocket → WS, else SSE.
    if (c.req.header("Upgrade")?.toLowerCase() === "websocket") {
      const Pair = (globalThis as unknown as { WebSocketPair?: WebSocketPairCtor })
        .WebSocketPair;
      if (!Pair) {
        return c.json(
          { error: "NotSupported", reason: "websockets-require-worker-or-ws-adapter" },
          426
        );
      }
      const pair = new Pair();
      const clientWs = pair[0];
      const serverWs = pair[1];
      serverWs.accept?.();
      // Pump in the background; don't await.
      void pumpWebSocket(serverWs, merged, combined, { keepaliveMs });
      return new Response(null, {
        status: 101,
        // Hono/undici-compat: some runtimes honor `webSocket` on the init.
        // @ts-expect-error - Workers-specific init field
        webSocket: clientWs,
      });
    }

    return sseResponse(merged, combined, { keepaliveMs });
  });
}

// ============================================================================
// Helpers
// ============================================================================

function getAuth(c: Context): ServiceAuth {
  const a = c.get("serviceAuth") as ServiceAuth | undefined;
  if (!a) throw new Error("service auth not set");
  return a;
}

/** Merge multiple AbortSignals into one. Aborts when any source aborts. */
function anySignal(signals: AbortSignal[]): AbortSignal {
  const ac = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      ac.abort();
      return ac.signal;
    }
    s.addEventListener("abort", () => ac.abort(), { once: true });
  }
  return ac.signal;
}

/** Wrap an iterable: drop events that don't pass the collection filter (if
 *  any), and close the outer controller as soon as we see a `member.removed`
 *  for the caller's own DID. */
function withSelfKickAndFilter(
  source: AsyncIterable<RealtimeEvent>,
  callerDid: string,
  collectionFilter: string | null,
  ac: AbortController
): AsyncIterable<RealtimeEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for await (const event of source) {
        if (event.kind === "member.removed" && event.payload.did === callerDid) {
          // Deliver the kick event so the client sees why, then close.
          yield event;
          ac.abort();
          return;
        }
        if (
          collectionFilter &&
          (event.kind === "record.created" || event.kind === "record.deleted") &&
          event.payload.collection !== collectionFilter
        ) {
          continue;
        }
        yield event;
      }
    },
  };
}
