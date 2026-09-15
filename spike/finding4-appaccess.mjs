// om-gb7r8: classify om-m2u6x FINDING 4 — "the appAccess guard fails open" —
// against pds.opnmt.net (throwaway spaces-alpha test PDS).
//
// The claim: SpacesSyncEngine.validateWatch (sync.ts:183-188) guards with
//     if (description.appAccess?.$type !== undefined &&
//         description.appAccess.$type !== "...#open") throw
// so an authority description with appAccess ABSENT (or present but with no
// $type) satisfies the guard and sync proceeds — where the sibling policy check
// three lines up (sync.ts:176-178) uses `description.policy?.$type !== expected`
// and therefore fails CLOSED on exactly the same shape.
//
// This is a crafted-input experiment: nothing is written to the server. The
// doctored description is injected in-process through config.protocol.fetch,
// which is the fetch the engine's transport uses (sync.ts:148-151), so the
// engine sees the synthetic getSpace body on the real code path.
//
// PART 1  BASELINE — what does a real authority actually emit? Every space on
//         this PDS is read back, including one created with no appAccess at all.
//         This is what decides DEMONSTRATED vs THEORETICAL.
// PART 2  MATRIX — validateWatch under six doctored descriptions, with the
//         policy field as the fail-closed control.
// PART 3  END TO END — a full reconcileSpace with appAccess stripped, to show
//         the short-circuit lets real sync work proceed, not just the guard pass.
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
} from "../packages/contrail-spaces-alpha/dist/index.js";
import { getDelegationToken, formatSpaceUri } from "../packages/contrail-spaces-alpha/dist/consumer.js";

const BASE = "https://pds.opnmt.net";
const GROUP_DID = "did:plc:jcwgw6fcnb5vyoid7nz7sl26";
const SPACE_TYPE = "net.openmeet.group";
const EVENT = "community.lexicon.calendar.event";
const RSVP = "community.lexicon.calendar.rsvp";
const space = formatSpaceUri({ authorityDid: GROUP_DID, type: SPACE_TYPE, skey: "kona" });
const PROBE_SKEY = "kona-f4probe";
const probeSpace = formatSpaceUri({ authorityDid: GROUP_DID, type: SPACE_TYPE, skey: PROBE_SKEY });

const creds = {};
for (const line of readFileSync("/workspaces/scratch/spaces-alpha-pds/spike-creds.env", "utf8").split("\n")) {
  const m = line.match(/^SPIKE_(\w+)_PASSWORD='(.+)'$/);
  if (m) creds[m[1].toLowerCase()] = m[2];
}
async function login(name) {
  const r = await fetch(`${BASE}/xrpc/com.atproto.server.createSession`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: `spike-${name}.opnmt.net`, password: creds[name] }),
  });
  if (!r.ok) throw new Error(`login ${name}: ${r.status}`);
  const d = await r.json();
  return { did: d.did, handle: (p, i = {}) => fetch(BASE + p, { ...i, headers: { ...(i.headers ?? {}), authorization: `Bearer ${d.accessJwt}` } }) };
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

const group = await login("group");
const bob = await login("bob");

// --- PART 1: what a real authority emits -------------------------------------
async function readSpace(uri) {
  const r = await group.handle(`/xrpc/com.atproto.simplespace.getSpace?${new URLSearchParams({ space: uri })}`);
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

// Two probes decide the threat model: (a) will this authority even ACCEPT a
// space with no appAccess, and (b) does every live space report the field back?
const noAppAccess = await group.handle("/xrpc/com.atproto.simplespace.createSpace", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({
    type: SPACE_TYPE, skey: PROBE_SKEY,
    policy: { $type: "com.atproto.simplespace.defs#publicPolicy" },
    // appAccess deliberately not sent
  }),
});
const noAppAccessBody = await noAppAccess.json().catch(() => ({}));
show("BASELINE A: createSpace with NO appAccess argument", { status: noAppAccess.status, body: noAppAccessBody });
check("BASELINE A: the authority REFUSES to create a space without appAccess",
  noAppAccess.status === 400 && /appAccess/.test(JSON.stringify(noAppAccessBody)),
  `${noAppAccess.status} ${noAppAccessBody.message ?? ""}`);

const withOpen = await group.handle("/xrpc/com.atproto.simplespace.createSpace", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({
    type: SPACE_TYPE, skey: PROBE_SKEY,
    policy: { $type: "com.atproto.simplespace.defs#publicPolicy" },
    appAccess: { $type: "com.atproto.simplespace.defs#open" },
  }),
});
show("BASELINE A2: same space created with an explicit open appAccess", { status: withOpen.status });

const baselines = [];
for (const [label, uri] of [
  ["kona (member-list)", space],
  ["kona-public (public policy)", formatSpaceUri({ authorityDid: GROUP_DID, type: SPACE_TYPE, skey: "kona-public" })],
  [`${PROBE_SKEY} (freshly created)`, probeSpace],
]) {
  const d = await readSpace(uri);
  baselines.push({ label, status: d.status, keys: Object.keys(d.body ?? {}), appAccess: d.body?.appAccess ?? null, policy: d.body?.policy?.$type ?? null });
}
show("BASELINE B: real getSpace responses from pds.opnmt.net", baselines);
const live = baselines.filter((b) => b.status === 200);
check("BASELINE B: every live space returns appAccess WITH a $type",
  live.length >= 3 && live.every((b) => b.appAccess && typeof b.appAccess.$type === "string"),
  `${live.length} live space(s): ${live.map((b) => b.appAccess?.$type ?? "ABSENT").join(", ")}`);

// --- engine wiring with a doctoring fetch ------------------------------------
let doctor = null; // (body) => body, applied to com.atproto.simplespace.getSpace only
const doctoringFetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const response = await globalThis.fetch(input, init);
  if (!doctor || !url.includes("com.atproto.simplespace.getSpace")) return response;
  const body = await response.clone().json().catch(() => null);
  if (!body) return response;
  return new Response(JSON.stringify(doctor(structuredClone(body))), {
    status: response.status,
    headers: { "content-type": "application/json" },
  });
};

const projection = resolveConfig({
  namespace: "net.openmeet.spike",
  profiles: [],
  collections: { event: { collection: EVENT }, rsvp: { collection: RSVP } },
});

const transport = await exchangeSpaceCredential({
  authorityPds: BASE,
  delegationToken: await getDelegationToken(bob, space),
  spaceUri: space,
});
const db = createSqliteDatabase(":memory:");
await initSpacesStorage(db, projection);
const watch0 = await ensureSpaceWatch(db, { spaceUri: space });
const encryptionKey = await generateCredentialEncryptionKey();
await saveCredential(db, {
  spaceUri: space, generation: watch0.generation, viewerDid: bob.did, encryptionKey,
  credential: transport.serialize(),
});
const warns = [];
const engine = new SpacesSyncEngine(db, {
  projection,
  spaceTypes: { [SPACE_TYPE]: { collections: [EVENT, RSVP], policy: "member-list" } },
  serviceAudience: "did:web:spike.openmeet.invalid#spike",
  credentialEncryptionKey: encryptionKey,
  notificationRegistration: "disabled",
  protocol: { fetch: doctoringFetch },
  logger: {
    log: () => {},
    warn: (...a) => { warns.push(a.map(String).join(" ")); },
    error: (...a) => { warns.push(a.map(String).join(" ")); },
  },
});
const watch = await getSpaceWatch(db, space);

// --- PART 2: the matrix ------------------------------------------------------
// Each case doctors ONE field of the authority description and asks the real
// validateWatch whether it will sync against it.
const OPEN = "com.atproto.simplespace.defs#open";
const cases = [
  { id: "control-untouched", field: "-", mutate: (b) => b, expect: "pass",
    why: "unmodified live description" },
  { id: "appAccess ABSENT", field: "appAccess", mutate: (b) => { delete b.appAccess; return b; }, expect: "?",
    why: "the finding: `?.` yields undefined, `!== undefined` is false, guard short-circuits" },
  { id: "appAccess {} (no $type)", field: "appAccess", mutate: (b) => { b.appAccess = {}; return b; }, expect: "?",
    why: "present but untyped — same short-circuit" },
  { id: "appAccess null", field: "appAccess", mutate: (b) => { b.appAccess = null; return b; }, expect: "?",
    why: "explicit null — `?.` short-circuits too" },
  { id: "appAccess allowList", field: "appAccess", mutate: (b) => { b.appAccess = { $type: "com.atproto.simplespace.defs#allowList", allowed: ["https://evil.example/client-metadata.json"] }; return b; }, expect: "throw",
    why: "CONTROL: with a $type present the guard does its job" },
  { id: "policy ABSENT (sibling)", field: "policy", mutate: (b) => { delete b.policy; return b; }, expect: "throw",
    why: "SIBLING CONTROL: the same shape one field over, at sync.ts:176-178" },
  { id: "policy {} (sibling, no $type)", field: "policy", mutate: (b) => { b.policy = {}; return b; }, expect: "throw",
    why: "SIBLING CONTROL: exactly the finding's shape — but fails CLOSED" },
];

const results = [];
for (const c of cases) {
  doctor = c.mutate;
  let observed, error = null;
  try {
    await engine.validateWatch(watch);
    observed = "pass";
  } catch (e) {
    observed = "throw";
    error = String(e).replace(/^Error:\s*/, "").slice(0, 90);
  }
  results.push({ case: c.id, field: c.field, observed, error, why: c.why });
}
doctor = null;
show("PART 2: validateWatch under doctored authority descriptions", results);

const byId = Object.fromEntries(results.map((r) => [r.case, r]));
check("control passes on the untouched live description",
  byId["control-untouched"].observed === "pass", byId["control-untouched"].error);
check("FINDING 4 CONFIRMED: appAccess ABSENT is accepted — guard fails OPEN",
  byId["appAccess ABSENT"].observed === "pass");
check("appAccess present-but-untyped ({}) is also accepted",
  byId["appAccess {} (no $type)"].observed === "pass");
check("appAccess null is also accepted",
  byId["appAccess null"].observed === "pass");
check("guard DOES fire when a $type is present (allowList refused)",
  byId["appAccess allowList"].observed === "throw", byId["appAccess allowList"].error);
check("ASYMMETRY: the sibling policy check fails CLOSED when absent",
  byId["policy ABSENT (sibling)"].observed === "throw", byId["policy ABSENT (sibling)"].error);
check("ASYMMETRY: the sibling fails CLOSED on the identical {} shape",
  byId["policy {} (sibling, no $type)"].observed === "throw", byId["policy {} (sibling, no $type)"].error);

// --- PART 3: does real sync work actually proceed? ---------------------------
doctor = (b) => { delete b.appAccess; return b; };
const warnsBefore = warns.length;
let reconcileError = null;
try {
  await engine.reconcileSpace(space, { deadline: Date.now() + 60_000 });
} catch (e) { reconcileError = String(e); }
doctor = null;
const after = await getSpaceWatch(db, space);
show("PART 3: full reconcileSpace with appAccess stripped from the authority", {
  threw: reconcileError,
  watchStatus: after.status,
  watchError: after.error,
  engineWarns: warns.slice(warnsBefore),
});
check("PART 3: sync PROCEEDED end-to-end against an appAccess-less authority",
  reconcileError === null && after.status === "active" && !after.error,
  `status=${after.status} error=${after.error ?? "none"}`);

// --- cleanup -----------------------------------------------------------------
const deleted = await group.handle("/xrpc/com.atproto.simplespace.deleteSpace", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ space: probeSpace }),
});
show("cleanup", `deleteSpace ${PROBE_SKEY} -> ${deleted.status}`);
check("cleanup: probe space deleted", deleted.status === 200, String(deleted.status));

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
