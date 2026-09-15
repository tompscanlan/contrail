// om-qcufs managing-app spike: a space whose policy is managingAppPolicy pointing
// at our tunnel-fronted gate. Tests: alice (gate allowlists) granted, mallory
// (gate denies) refused, and fail-closed when the service fragment can't resolve.
import { readFileSync } from "node:fs";
import {
  createSpace,
  createSpaceRecord,
  updateSimpleSpacePolicy,
  getDelegationToken,
  formatSpaceUri,
} from "../packages/contrail-spaces-alpha/dist/consumer.js";
import { exchangeSpaceCredential } from "../packages/contrail-spaces-alpha/dist/index.js";

const BASE = "https://pds.opnmt.net";
const GROUP_DID = "did:plc:jcwgw6fcnb5vyoid7nz7sl26";
const GATE_DID = "did:web:carriers-binary-resistant-favor.trycloudflare.com#spike_gate";
const SPACE_TYPE = "net.openmeet.group";
const space = formatSpaceUri({ authorityDid: GROUP_DID, type: SPACE_TYPE, skey: "kona-gated" });

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
  console.log(JSON.stringify(value, null, 2));
}

async function dance(name, session) {
  const delegation = await getDelegationToken(session, space);
  const t = await exchangeSpaceCredential({
    authorityPds: BASE,
    delegationToken: delegation,
    spaceUri: space,
  });
  return t;
}

async function listRecordsViaCredential(transport, repo, collection) {
  const params = new URLSearchParams({ space, repo, collection });
  const r = await transport.fetch(`${BASE}/xrpc/com.atproto.space.listRecords?${params}`);
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
}

const group = await login("group");
const alice = await login("alice");
const mallory = await login("mallory");

// 1. Create the gated space — note: NO members are ever added. Access is entirely
//    the gate's call.
try {
  show("1 createSpace (managing-app -> our gate)", await createSpace(group, {
    type: SPACE_TYPE,
    skey: "kona-gated",
    policy: { kind: "managing-app", managingApp: GATE_DID },
  }));
} catch (e) {
  show("1 createSpace FAILED (already exists is fine on re-run)", String(e));
}

// 2. Group writes an event.
try {
  show("2 group writes event", await createSpaceRecord(group, {
    space,
    collection: "community.lexicon.calendar.event",
    record: {
      $type: "community.lexicon.calendar.event",
      name: "Spike: members-only planning session (gated)",
      description: "managingAppPolicy spike event (om-qcufs).",
      createdAt: new Date().toISOString(),
      startsAt: new Date(Date.now() + 7 * 864e5).toISOString(),
      mode: "community.lexicon.calendar.event#inperson",
      status: "community.lexicon.calendar.event#planned",
    },
  }));
} catch (e) {
  show("2 event write FAILED", String(e));
}

// 3. Alice: gate allowlists her DID -> expect credential + read.
try {
  const t = await dance("alice", alice);
  show("3 alice credential via GATE", { expiresAt: new Date(t.expiresAt).toISOString() });
  show("3b alice reads gated event", await listRecordsViaCredential(t, GROUP_DID, "community.lexicon.calendar.event"));
} catch (e) {
  show("3 alice FAILED", String(e));
}

// 4. Mallory: gate denies -> expect UserNotAuthorized.
try {
  await dance("mallory", mallory);
  show("4 mallory", "CREDENTIAL GRANTED — gate NOT consulted?!");
} catch (e) {
  show("4 mallory refused (expected)", String(e));
}

// 5. Fail-closed: repoint the policy at a fragment the did.json does not carry.
//    Resolution fails -> the PDS must DENY even alice.
try {
  await updateSimpleSpacePolicy(group, space, {
    kind: "managing-app",
    managingApp: GATE_DID.replace("#spike_gate", "#no_such_service"),
  });
  show("5 policy repointed at #no_such_service", "ok");
  try {
    await dance("alice", alice);
    show("5b alice after breakage", "GRANTED — NOT fail-closed?!");
  } catch (e) {
    show("5b alice denied (fail-closed confirmed)", String(e));
  }
} finally {
  await updateSimpleSpacePolicy(group, space, { kind: "managing-app", managingApp: GATE_DID });
  show("6 policy restored to working gate", "ok");
}
