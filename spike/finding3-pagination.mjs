// om-gb7r8: classify om-m2u6x FINDING 3 — "unbounded oplog pagination" — under
// real use against pds.opnmt.net (throwaway spaces-alpha test PDS).
//
// The claim: in SpacesSyncEngine.incrementalRepo (sync.ts:395-451) the
// do{}while(cursor) loop has no deadline, and the only bound on it is the
// maxAtomicMutations cap (sync.ts:445-447, repeated at :471-473) which counts
// events[] — but the collectionAllowed skip at sync.ts:410 `continue`s BEFORE
// events[] is bumped. So ops in a collection the consumer has NOT configured
// are paged, hashed, and discarded without ever touching the cap, and one
// reconcileSpace invocation must drain the entire backlog.
//
// Phases (RSVP is deliberately UNCONFIGURED in spaceTypes; EVENT is configured):
//   SYNC0  baseline — establish local state (full recovery).
//   PHASE A  write 25 RSVP ops, reconcile once. Expect: every op paged, cap
//            never fires, zero events ingested, sync succeeds. 25 >> the cap of 10.
//   PHASE B  write 5 more RSVP ops, reconcile with a 2s deadline and a fetch
//            that makes each listRepoOps page take 4s. Expect: reconcileSpace
//            returns LATE — incrementalRepo takes no deadline (call site :349,
//            signature :384-389) unlike the writer-listing loop at :245-261.
//   PHASE C  CONTROL — write 12 EVENT ops (a CONFIGURED collection) and
//            reconcile. Expect: the cap throws at op 11 and syncRepo falls back
//            to full-CAR recovery. Same op count, opposite behavior — that
//            contrast is the finding.
// Tokens/credentials are never printed.
import { readFileSync } from "node:fs";
import { createSqliteDatabase } from "../packages/contrail/dist/adapters/sqlite.js";
import { resolveConfig } from "../packages/contrail/dist/index.js";
import {
  SpacesSyncEngine,
  initSpacesStorage,
  ensureSpaceWatch,
  getSpaceWatch,
  saveCredential,
  generateCredentialEncryptionKey,
  exchangeSpaceCredential,
  listRepoStates,
} from "../packages/contrail-spaces-alpha/dist/index.js";
import {
  getDelegationToken,
  createSpaceRecord,
  deleteSpaceRecord,
  formatSpaceUri,
} from "../packages/contrail-spaces-alpha/dist/consumer.js";

const BASE = "https://pds.opnmt.net";
const GROUP_DID = "did:plc:jcwgw6fcnb5vyoid7nz7sl26";
const SPACE_TYPE = "net.openmeet.group";
const EVENT = "community.lexicon.calendar.event";
const RSVP = "community.lexicon.calendar.rsvp";
const space = formatSpaceUri({ authorityDid: GROUP_DID, type: SPACE_TYPE, skey: "kona" });

const N_RSVP_A = 25;   // >> maxAtomicMutations default of 10
const N_RSVP_B = 5;
const N_EVENT_C = 12;  // > 10, so the cap must fire for a CONFIGURED collection
const SLOW_PAGE_MS = 4000;
const DEADLINE_MS = 2000;

const creds = {};
for (const line of readFileSync("/workspaces/scratch/spaces-alpha-pds/spike-creds.env", "utf8").split("\n")) {
  const m = line.match(/^SPIKE_(\w+)_PASSWORD='(.+)'$/);
  if (m) creds[m[1].toLowerCase()] = m[2];
}

async function login(name) {
  const r = await fetch(`${BASE}/xrpc/com.atproto.server.createSession`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: `spike-${name}.opnmt.net`, password: creds[name] }),
  });
  if (!r.ok) throw new Error(`login ${name}: ${r.status} ${await r.text()}`);
  const d = await r.json();
  return {
    did: d.did,
    handle: (pathname, init = {}) =>
      fetch(BASE + pathname, {
        ...init,
        headers: { ...(init.headers ?? {}), authorization: `Bearer ${d.accessJwt}` },
      }),
  };
}

function show(label, value) {
  console.log(`\n=== ${label} ===`);
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
}
const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- instrumented transport --------------------------------------------------
// Counts every XRPC call the engine makes and, for listRepoOps, counts the ops
// on each page as they come back. slowPageMs delays only listRepoOps responses.
let slowPageMs = 0;
const xrpcCalls = [];
const opPages = []; // { ops, cursor } per listRepoOps page
const instrumentedFetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const m = url.match(/pds\.opnmt\.net\/xrpc\/([^?]+)/);
  if (m) xrpcCalls.push(m[1]);
  const response = await globalThis.fetch(input, init);
  if (m && m[1] === "com.atproto.space.listRepoOps") {
    if (slowPageMs) await sleep(slowPageMs);
    try {
      const body = await response.clone().json();
      opPages.push({ ops: body.ops?.length ?? 0, cursor: body.cursor ?? null });
    } catch { /* non-JSON error body; the tally still records the call */ }
  }
  return response;
};

const projection = resolveConfig({
  namespace: "net.openmeet.spike",
  profiles: [],
  // BOTH collections are projectable; only the engine's spaceTypes gates ingest,
  // so "zero rsvp rows" below means the sync skipped them, not that the
  // projection had nowhere to put them.
  collections: { event: { collection: EVENT }, rsvp: { collection: RSVP } },
});

const group = await login("group");
const bob = await login("bob");

const transport = await exchangeSpaceCredential({
  authorityPds: BASE,
  delegationToken: await getDelegationToken(bob, space),
  spaceUri: space,
});

const db = createSqliteDatabase(":memory:");
await initSpacesStorage(db, projection);
const watch = await ensureSpaceWatch(db, { spaceUri: space });
const encryptionKey = await generateCredentialEncryptionKey();
await saveCredential(db, {
  spaceUri: space,
  generation: watch.generation,
  viewerDid: bob.did,
  encryptionKey,
  credential: transport.serialize(),
});

const warns = [];
const engine = new SpacesSyncEngine(db, {
  projection,
  // RSVP DELIBERATELY OMITTED — this is the whole experiment.
  spaceTypes: { [SPACE_TYPE]: { collections: [EVENT], policy: "member-list" } },
  serviceAudience: "did:web:spike.openmeet.invalid#spike",
  credentialEncryptionKey: encryptionKey,
  notificationRegistration: "disabled",
  protocol: { fetch: instrumentedFetch },
  logger: {
    log: (...a) => console.log("[engine]", ...a),
    warn: (...a) => { warns.push(a.map(String).join(" ")); console.log("[engine WARN]", ...a); },
    error: (...a) => console.log("[engine ERROR]", ...a),
  },
});

async function runSync(label, { deadlineMs = 120_000 } = {}) {
  const callsBefore = xrpcCalls.length;
  const pagesBefore = opPages.length;
  const warnsBefore = warns.length;
  const started = Date.now();
  await engine.reconcileSpace(space, { deadline: started + deadlineMs });
  const elapsed = Date.now() - started;
  const calls = xrpcCalls.slice(callsBefore);
  const tally = {};
  for (const c of calls) tally[c] = (tally[c] ?? 0) + 1;
  const pages = opPages.slice(pagesBefore);
  const w = await getSpaceWatch(db, space);
  const states = await listRepoStates(db, w);
  show(`${label}: engine XRPC calls`, tally);
  show(`${label}: listRepoOps pages`, { pages: pages.length, opsPerPage: pages.map((p) => p.ops), totalOps: pages.reduce((n, p) => n + p.ops, 0) });
  show(`${label}: elapsed`, `${elapsed} ms`);
  return { tally, pages, elapsed, newWarns: warns.slice(warnsBefore), states, watch: w };
}

async function rowCount(table) {
  try {
    const { results } = await db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).all();
    return results[0].n;
  } catch { return null; }
}

const written = { rsvp: [], event: [] };
async function writeRsvps(n, tag) {
  const started = Date.now();
  for (let i = 0; i < n; i++) {
    const r = await createSpaceRecord(group, {
      space, collection: RSVP,
      record: {
        $type: RSVP,
        subject: { uri: `at://${GROUP_DID}/${EVENT}/f3-${tag}-${i}`, cid: "bafyreib2rxk3rybk3aobmv5cjuql3bm2twh4jo5uejr5ib5msjlbcjqfla" },
        status: "community.lexicon.calendar.rsvp#going",
        createdAt: new Date().toISOString(),
      },
    });
    written.rsvp.push(r.uri.split("/").pop());
  }
  show(`wrote ${n} RSVP records (${tag})`, `${Date.now() - started} ms — collection is UNCONFIGURED in spaceTypes`);
}

// --- SYNC 0: baseline --------------------------------------------------------
const s0 = await runSync("SYNC0 baseline");
show("SYNC0: repo states", s0.states.map((s) => ({ repo: s.repoDid, rev: s.rev })));
check("SYNC0 established local state", s0.states.length >= 1);
const rev0 = s0.states.find((s) => s.repoDid === GROUP_DID)?.rev;

// --- PHASE A: unconfigured collection, 25 ops, one reconcile -----------------
await writeRsvps(N_RSVP_A, "a");
const a = await runSync("PHASE A (25 unconfigured RSVP ops)");
const aOps = a.pages.reduce((n, p) => n + p.ops, 0);
const rsvpRows = await rowCount("isolated_records_rsvp");
const revA = a.states.find((s) => s.repoDid === GROUP_DID)?.rev;
show("PHASE A: projected rows", { rsvp: rsvpRows, event: await rowCount("isolated_records_event") });
check(`PHASE A paged all ${N_RSVP_A} ops in ONE reconcile invocation`,
  aOps >= N_RSVP_A, `${aOps} ops over ${a.pages.length} page(s)`);
check(`PHASE A drained ${aOps} ops with the cap set to 10 and never threw`,
  a.newWarns.length === 0 && (a.tally["com.atproto.space.getRepo"] ?? 0) === 0,
  a.newWarns.join(" | ") || `no warns, getRepo=${a.tally["com.atproto.space.getRepo"] ?? 0}`);
check("PHASE A ingested ZERO records (every op skipped at sync.ts:410)",
  rsvpRows === 0, `isolated_records_rsvp rows = ${rsvpRows}`);
check("PHASE A still advanced the checkpoint rev", revA !== rev0, `${rev0} -> ${revA}`);

// --- PHASE B: does the deadline bound this loop? -----------------------------
await writeRsvps(N_RSVP_B, "b");
slowPageMs = SLOW_PAGE_MS;
show("PHASE B setup", `each listRepoOps page now takes ${SLOW_PAGE_MS} ms; reconcileSpace deadline = ${DEADLINE_MS} ms`);
const b = await runSync("PHASE B (deadline probe)", { deadlineMs: DEADLINE_MS });
slowPageMs = 0;
const bOps = b.pages.reduce((n, p) => n + p.ops, 0);
check("PHASE B ran PAST its deadline inside incrementalRepo",
  b.elapsed > DEADLINE_MS,
  `elapsed ${b.elapsed} ms vs ${DEADLINE_MS} ms deadline (overrun ${b.elapsed - DEADLINE_MS} ms, ${b.pages.length} slow page(s), ${bOps} ops)`);
check("PHASE B completed anyway — no deadline abort, no fallback",
  b.newWarns.length === 0 && (b.tally["com.atproto.space.getRepo"] ?? 0) === 0,
  b.newWarns.join(" | ") || "no warns");

// --- PHASE C: CONTROL — same shape, but a CONFIGURED collection --------------
const revB = b.states.find((s) => s.repoDid === GROUP_DID)?.rev;
const startedC = Date.now();
for (let i = 0; i < N_EVENT_C; i++) {
  const r = await createSpaceRecord(group, {
    space, collection: EVENT,
    record: {
      $type: EVENT,
      name: `Spike: finding-3 control event ${i}`,
      description: "CONFIGURED collection — the cap must fire (om-gb7r8)",
      createdAt: new Date().toISOString(),
      startsAt: new Date(Date.now() + 7 * 864e5).toISOString(),
      mode: "community.lexicon.calendar.event#inperson",
      status: "community.lexicon.calendar.event#planned",
    },
  });
  written.event.push(r.uri.split("/").pop());
}
show(`wrote ${N_EVENT_C} EVENT records (control)`, `${Date.now() - startedC} ms — collection IS configured in spaceTypes`);

const c = await runSync("PHASE C control (12 configured EVENT ops)");
const capThrew = c.newWarns.some((w) => w.includes("bounded atomic mutation limit"));
check("PHASE C: the cap fired for the CONFIGURED collection",
  capThrew, c.newWarns.join(" | ").slice(0, 300) || "no warns");
check("PHASE C: syncRepo fell back to full-CAR recovery",
  (c.tally["com.atproto.space.getRepo"] ?? 0) >= 1, JSON.stringify(c.tally));
show("CONTRAST", {
  unconfigured_RSVP: { ops: aOps, capFired: false, fallback: false },
  configured_EVENT: { ops: N_EVENT_C, capFired: capThrew, fallback: (c.tally["com.atproto.space.getRepo"] ?? 0) >= 1 },
  note: "same engine, same cap of 10, opposite bound — collectionAllowed at sync.ts:410 continues before events[] is bumped",
});

// --- cleanup -----------------------------------------------------------------
let cleaned = 0;
for (const rkey of written.rsvp) {
  try { await deleteSpaceRecord(group, { space, collection: RSVP, rkey }); cleaned++; } catch { /* best-effort */ }
}
for (const rkey of written.event) {
  try { await deleteSpaceRecord(group, { space, collection: EVENT, rkey }); cleaned++; } catch { /* best-effort */ }
}
show("cleanup", `deleted ${cleaned}/${written.rsvp.length + written.event.length} spike records from the space`);

const failed = checks.filter((ck) => !ck.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
