// om-qcufs sync-engine spike: drive #95's SpacesSyncEngine live against
// pds.opnmt.net (kona, member-list) and test om-m2u6x FINDING 1 —
// a record created-then-updated between syncs yields an oplog entry whose
// value is legally omitted (superseded), which sync.ts treats as a fault and
// answers with full-CAR recovery of the whole repo.
//
// Phases:
//   SYNC1  baseline — no local state, full recovery expected for every writer.
//   SYNC2  CONTROL — one update between syncs; incremental path must succeed
//          (proves the incremental machinery works when values are present).
//   SYNC3  REPRO — create+update the same rkey between syncs; expect the
//          "Incremental operation omitted its record value" throw and the
//          fall-back to com.atproto.space.getRepo (full CAR).
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
  listRepoOps,
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

async function putSpaceRecord(session, { space, collection, rkey, record }) {
  const r = await session.handle("/xrpc/com.atproto.space.putRecord", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ space, repo: session.did, collection, rkey, validate: false, record }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`putRecord ${r.status}: ${JSON.stringify(body)}`);
  return body;
}

function show(label, value) {
  console.log(`\n=== ${label} ===`);
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

// --- engine wiring -----------------------------------------------------------
const warns = [];
const xrpcCalls = []; // { method } for every pds.opnmt.net XRPC call the engine makes
const countingFetch = (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const m = url.match(/pds\.opnmt\.net\/xrpc\/([^?]+)/);
  if (m) xrpcCalls.push(m[1]);
  return globalThis.fetch(input, init);
};

const projection = resolveConfig({
  namespace: "net.openmeet.spike",
  profiles: [],
  collections: {
    event: { collection: EVENT },
    rsvp: { collection: RSVP },
  },
});

const bob = await login("bob");
const group = await login("group");

const transport = await exchangeSpaceCredential({
  authorityPds: BASE,
  delegationToken: await getDelegationToken(bob, space),
  spaceUri: space,
});
show("credential obtained (bob, viewer)", { expiresAt: new Date(transport.expiresAt).toISOString() });

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

const engine = new SpacesSyncEngine(db, {
  projection,
  spaceTypes: { [SPACE_TYPE]: { collections: [EVENT, RSVP], policy: "member-list" } },
  serviceAudience: "did:web:spike.openmeet.invalid#spike",
  credentialEncryptionKey: encryptionKey,
  notificationRegistration: "disabled",
  protocol: { fetch: countingFetch },
  logger: {
    log: (...a) => console.log("[engine]", ...a),
    warn: (...a) => { warns.push(a.map(String).join(" ")); console.log("[engine WARN]", ...a); },
    error: (...a) => console.log("[engine ERROR]", ...a),
  },
});

async function runSync(label) {
  const before = xrpcCalls.length;
  const warnsBefore = warns.length;
  await engine.reconcileSpace(space, { deadline: Date.now() + 120_000 });
  const calls = xrpcCalls.slice(before);
  const tally = {};
  for (const c of calls) tally[c] = (tally[c] ?? 0) + 1;
  const w = await getSpaceWatch(db, space);
  const states = await listRepoStates(db, w);
  show(`${label}: engine XRPC calls`, tally);
  show(`${label}: repo states`, states.map((s) => ({
    repo: s.repoDid, rev: s.rev, writerGen: s.visibleWriterGeneration,
  })));
  return { tally, newWarns: warns.slice(warnsBefore), states };
}

async function projectedRecords() {
  const { results: tables } = await db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
  const out = {};
  for (const { name } of tables) {
    const { results } = await db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).all();
    if (results[0].n > 0) out[name] = results[0].n;
  }
  return out;
}

async function projectedEventNames() {
  const { results } = await db
    .prepare("SELECT rkey, record FROM isolated_records_event ORDER BY rkey").all();
  return results.map((r) => {
    try {
      const v = JSON.parse(r.record);
      return { rkey: r.rkey, name: v.name, description: v.description };
    } catch {
      return { rkey: r.rkey };
    }
  });
}

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

// --- SYNC 1: baseline --------------------------------------------------------
const s1 = await runSync("SYNC1 baseline");
show("SYNC1: non-empty tables", await projectedRecords());
check("SYNC1 full recovery used getRepo (no prior state)",
  (s1.tally["com.atproto.space.getRepo"] ?? 0) >= 1,
  `getRepo=${s1.tally["com.atproto.space.getRepo"] ?? 0}`);

// --- SYNC 2: CONTROL — one plain update, incremental must hold ---------------
const groupState1 = s1.states.find((s) => s.repoDid === GROUP_DID);
const evList = await (await group.handle(
  `/xrpc/com.atproto.space.listRecords?${new URLSearchParams({ space, repo: GROUP_DID, collection: EVENT })}`,
)).json();
const existing = evList.records[0];
const existingRkey = existing.rkey;
await putSpaceRecord(group, {
  space, collection: EVENT, rkey: existingRkey,
  record: { ...existing.value, description: `control update ${new Date().toISOString()} (om-qcufs sync spike)` },
});
show("CONTROL write", `updated existing event ${existingRkey} once`);

const s2 = await runSync("SYNC2 control");
check("SYNC2 incremental path succeeded (no fallback warn)",
  s2.newWarns.length === 0, s2.newWarns.join(" | ") || "no warns");
check("SYNC2 used listRepoOps, not getRepo",
  (s2.tally["com.atproto.space.listRepoOps"] ?? 0) >= 1 &&
  (s2.tally["com.atproto.space.getRepo"] ?? 0) === 0,
  JSON.stringify(s2.tally));
check("SYNC2 rev advanced for group repo",
  s2.states.find((s) => s.repoDid === GROUP_DID)?.rev !== groupState1?.rev);

// --- SYNC 3: REPRO — create-then-update between syncs ------------------------
const groupState2 = s2.states.find((s) => s.repoDid === GROUP_DID);
const created = await createSpaceRecord(group, {
  space, collection: EVENT,
  record: {
    $type: EVENT,
    name: "Spike: created-then-updated repro (om-m2u6x F1)",
    description: "v1 — should be superseded before the next sync",
    createdAt: new Date().toISOString(),
    startsAt: new Date(Date.now() + 7 * 864e5).toISOString(),
    mode: "community.lexicon.calendar.event#inperson",
    status: "community.lexicon.calendar.event#planned",
  },
});
const reproRkey = created.uri.split("/").pop();
await putSpaceRecord(group, {
  space, collection: EVENT, rkey: reproRkey,
  record: {
    $type: EVENT,
    name: "Spike: created-then-updated repro (om-m2u6x F1)",
    description: "v2 — the superseding update",
    createdAt: new Date().toISOString(),
    startsAt: new Date(Date.now() + 7 * 864e5).toISOString(),
    mode: "community.lexicon.calendar.event#inperson",
    status: "community.lexicon.calendar.event#planned",
  },
});
show("REPRO writes", `created ${reproRkey}, then updated it — two ops since rev ${groupState2.rev}`);

// Direct server evidence first: what does the oplog actually return?
const rawOps = await listRepoOps(transport, BASE, {
  space, repo: GROUP_DID, since: groupState2.rev, limit: 100,
});
show("REPRO raw listRepoOps since control rev", rawOps.ops.map((op) => ({
  rev: op.rev, rkey: op.rkey,
  cid: op.cid ? "set" : null, prev: op.prev ? "set" : null,
  value: op.value === undefined ? "OMITTED" : "present",
})));
const superseded = rawOps.ops.filter((op) => op.cid && op.value === undefined);
check("server omits value on the superseded op (spec-legal)",
  superseded.length >= 1, `${superseded.length} op(s) with cid set but value omitted`);

const s3 = await runSync("SYNC3 repro");
const fellBack = s3.newWarns.some((w) => w.includes("fell back to recovery"));
const rightCause = s3.newWarns.some((w) => w.includes("omitted its record value"));
check("SYNC3 incremental threw and fell back to full CAR recovery",
  fellBack && (s3.tally["com.atproto.space.getRepo"] ?? 0) >= 1,
  JSON.stringify(s3.tally));
check("SYNC3 failure cause is the omitted-value throw (finding 1)",
  rightCause, s3.newWarns.join(" | ").slice(0, 300));
const names = await projectedEventNames();
show("projection after SYNC3 (event rows)", names);
check("repro record present in projection after CAR recovery",
  names.some((n) => n.rkey === reproRkey));

// --- cleanup: put fixtures back (kona keeps 1 event + 1 rsvp) ----------------
await deleteSpaceRecord(group, { space, collection: EVENT, rkey: reproRkey });
show("cleanup", `deleted repro record ${reproRkey} from the space (projection is a throwaway :memory: db)`);

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
