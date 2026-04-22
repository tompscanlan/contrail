/** Durable Object backend for realtime PubSub.
 *
 *  Two pieces live here:
 *   1. `RealtimePubSubDO` — the DO class. Ship it from your Worker via
 *      `export { RealtimePubSubDO } from "@atmo-dev/contrail";` and bind it in
 *      your `wrangler.toml`. One DO = one topic; addressed by name.
 *   2. `DurableObjectPubSub` — client-side adapter implementing the PubSub
 *      interface against a DO namespace binding.
 *
 *  Wire format between Worker and DO (internal, not a stable public contract):
 *    POST  /publish    — body = RealtimeEvent JSON
 *    GET   /subscribe  — server-sent events stream, optionally with
 *                         `Upgrade: websocket` for WS connections.
 *                         Auth/ACL is already checked at the Worker edge;
 *                         the DO trusts anything that reaches it. */

import type { PubSub, RealtimeEvent } from "./types";

// ---- Minimal structural typings so we don't depend on @cloudflare/workers-types
// at the library level. Callers on Workers will have proper types.
// ----------------------------------------------------------------------------

export interface DurableObjectId {
  toString(): string;
}

export interface DurableObjectStub {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

export interface DurableObjectState {
  acceptWebSocket(ws: any, tags?: string[]): void;
  getWebSockets(tag?: string): any[];
}

// ----------------------------------------------------------------------------
// Client adapter
// ----------------------------------------------------------------------------

export class DurableObjectPubSub implements PubSub {
  constructor(private readonly namespace: DurableObjectNamespace) {}

  private stub(topic: string): DurableObjectStub {
    return this.namespace.get(this.namespace.idFromName(topic));
  }

  async publish(event: RealtimeEvent): Promise<void> {
    const res = await this.stub(event.topic).fetch("https://do/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    });
    if (!res.ok) {
      // Consume the body so the edge doesn't hold a dangling response.
      await res.text().catch(() => "");
      throw new Error(`DO publish failed (${res.status})`);
    }
  }

  /** In-Worker server-side subscribe. Browsers should hit the SSE endpoint
   *  directly; this is the path for an in-process consumer that wants an
   *  AsyncIterable (tests, bots embedded in the Worker). */
  subscribe(topic: string, signal?: AbortSignal): AsyncIterable<RealtimeEvent> {
    const stub = this.stub(topic);
    return {
      [Symbol.asyncIterator]() {
        return pullIterator(stub, signal);
      },
    };
  }
}

function pullIterator(
  stub: DurableObjectStub,
  signal?: AbortSignal
): AsyncIterator<RealtimeEvent> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let buf = "";
  const decoder = new TextDecoder();
  const ac = new AbortController();
  if (signal) {
    if (signal.aborted) ac.abort();
    else signal.addEventListener("abort", () => ac.abort(), { once: true });
  }

  const open = async () => {
    const res = await stub.fetch("https://do/subscribe", {
      method: "GET",
      headers: { accept: "text/event-stream" },
      signal: ac.signal,
    });
    if (!res.ok || !res.body) throw new Error(`DO subscribe failed (${res.status})`);
    reader = res.body.getReader();
  };

  return {
    async next(): Promise<IteratorResult<RealtimeEvent>> {
      if (!reader) await open();
      while (true) {
        // Drain buffered frames.
        while (true) {
          const sep = buf.indexOf("\n\n");
          if (sep < 0) break;
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          let data: string | null = null;
          for (const line of frame.split("\n")) {
            if (line.startsWith(":")) continue;
            if (line.startsWith("data:")) data = line.slice(5).trim();
          }
          if (data) {
            try {
              return { value: JSON.parse(data) as RealtimeEvent, done: false };
            } catch {
              /* skip malformed */
            }
          }
        }
        if (ac.signal.aborted) return { value: undefined, done: true };
        const r = await reader!.read();
        if (r.done) return { value: undefined, done: true };
        buf += decoder.decode(r.value, { stream: true });
      }
    },
    async return(): Promise<IteratorResult<RealtimeEvent>> {
      ac.abort();
      try {
        await reader?.cancel();
      } catch {
        /* ignore */
      }
      return { value: undefined, done: true };
    },
  };
}

// ----------------------------------------------------------------------------
// Durable Object class
// ----------------------------------------------------------------------------

/** The Durable Object implementation. Each DO instance owns the fan-out for
 *  exactly one topic. WebSocket connections are stored via the Hibernation
 *  API (`state.acceptWebSocket`) so idle rooms cost near-zero.
 *
 *  This class intentionally avoids the `DurableObject` base class so we don't
 *  have to depend on @cloudflare/workers-types at the library level — users
 *  wire it up directly in their Worker entry. */
export class RealtimePubSubDO {
  constructor(
    protected readonly state: DurableObjectState,
    _env?: unknown
  ) {}

  /** Worker entry delegates `fetch` to this method. */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/publish") {
      let event: RealtimeEvent;
      try {
        event = (await request.json()) as RealtimeEvent;
      } catch {
        return new Response(JSON.stringify({ error: "InvalidRequest" }), { status: 400 });
      }
      this.publishEvent(event);
      return new Response("{}", { status: 200 });
    }
    if (request.method === "GET" && url.pathname === "/subscribe") {
      const did = url.searchParams.get("did") ?? undefined;
      if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
        const Pair = (globalThis as unknown as { WebSocketPair?: any }).WebSocketPair;
        if (!Pair) return new Response("websockets require Workers", { status: 426 });
        const pair = new Pair();
        this.acceptWebSocketSubscriber(pair[1], did);
        return new Response(null, {
          status: 101,
          // @ts-expect-error Workers-specific init field
          webSocket: pair[0],
        });
      }
      return this.openSseResponse(did);
    }
    return new Response("not found", { status: 404 });
  }

  /** Fan-out an event to every connected subscriber (WS + SSE).
   *  Public so tests + advanced callers can skip the HTTP layer. */
  publishEvent(event: RealtimeEvent): void {
    const payload = JSON.stringify(event);
    const frame = `event: ${event.kind}\ndata: ${payload}\n\n`;

    for (const ws of this.state.getWebSockets()) {
      try {
        ws.send(payload);
      } catch {
        /* ignore — socket may be closing */
      }
      const attachment = getAttachment(ws);
      if (
        event.kind === "member.removed" &&
        attachment?.did &&
        event.payload.did === attachment.did
      ) {
        try {
          ws.close(4003, "membership-revoked");
        } catch {
          /* ignore */
        }
      }
    }
    for (const entry of this.sseControllers) {
      try {
        entry.controller.enqueue(this.encoder.encode(frame));
      } catch {
        /* drop; cleanup happens on the subscribe-side */
      }
      if (
        event.kind === "member.removed" &&
        entry.did &&
        event.payload.did === entry.did
      ) {
        try {
          entry.controller.close();
        } catch {
          /* ignore */
        }
      }
    }
  }

  /** Register a server-side WebSocket as a subscriber. Wires the DID attachment. */
  acceptWebSocketSubscriber(serverWs: any, did?: string): void {
    this.state.acceptWebSocket(serverWs, did ? [did] : undefined);
    if (did) setAttachment(serverWs, { did });
  }

  /** Open an SSE subscriber; returns the streaming Response. */
  openSseResponse(did?: string): Response {
    let entry: SseEntry;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        entry = { controller, did };
        this.sseControllers.add(entry);
        controller.enqueue(this.encoder.encode(`: open\n\n`));
      },
      cancel: () => {
        this.sseControllers.delete(entry);
      },
    });
    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      },
    });
  }

  private readonly sseControllers = new Set<SseEntry>();
  private readonly encoder = new TextEncoder();
}

interface SseEntry {
  controller: ReadableStreamDefaultController<Uint8Array>;
  did: string | undefined;
}

interface WsAttachment {
  did?: string;
}

function setAttachment(ws: any, attachment: WsAttachment): void {
  try {
    ws.serializeAttachment?.(attachment);
  } catch {
    /* non-hibernating socket — fall back to a direct property */
    ws.__attachment = attachment;
  }
}

function getAttachment(ws: any): WsAttachment | null {
  try {
    const a = ws.deserializeAttachment?.();
    if (a) return a as WsAttachment;
  } catch {
    /* ignore */
  }
  return (ws.__attachment as WsAttachment | undefined) ?? null;
}
