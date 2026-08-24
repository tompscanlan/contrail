// om-qcufs write-path spike: drive #95's consumer functions against pds.opnmt.net.
// Creds come from spike-creds.env (never printed); output is DIDs/URIs/status only.
import { readFileSync } from "node:fs";
import {
  createSpace,
  addSimpleSpaceMember,
  listSimpleSpaceMembers,
  createSpaceRecord,
  formatSpaceUri,
} from "../packages/contrail-spaces-alpha/dist/consumer.js";

const BASE = "https://pds.opnmt.net";
const SPACE_TYPE = "net.openmeet.group";

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

const anon = { did: null, handle: (pathname, init = {}) => fetch(BASE + pathname, init) };

async function listRecords(session, space, repo, collection) {
  const params = new URLSearchParams({ space, repo });
  if (collection) params.set("collection", collection);
  const r = await session.handle(`/xrpc/com.atproto.space.listRecords?${params}`);
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
}

function show(label, value) {
  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(value, null, 2));
}

const iso = (d) => d.toISOString();
const now = new Date();
const nextWeek = new Date(now.getTime() + 7 * 864e5);

const group = await login("group");
const alice = await login("alice");
const bob = await login("bob");
show("sessions", { group: group.did, alice: alice.did, bob: bob.did });

// ---- Phase A: member-list space (the private/group model) ----
const spaceUri = formatSpaceUri({ authorityDid: group.did, type: SPACE_TYPE, skey: "kona" });
try {
  const created = await createSpace(group, { type: SPACE_TYPE, skey: "kona", policy: { kind: "member-list" } });
  show("A1 createSpace (member-list)", created);
} catch (e) {
  show("A1 createSpace FAILED", String(e));
}

for (const [name, member] of [["alice", alice], ["bob", bob]]) {
  try {
    await addSimpleSpaceMember(group, spaceUri, member.did);
    show(`A2 addMember ${name}`, "ok");
  } catch (e) {
    show(`A2 addMember ${name} FAILED`, String(e));
  }
}

try {
  show("A3 listMembers", await listSimpleSpaceMembers(group, { space: spaceUri }));
} catch (e) {
  show("A3 listMembers FAILED", String(e));
}

let eventRef = null;
try {
  eventRef = await createSpaceRecord(group, {
    space: spaceUri,
    collection: "community.lexicon.calendar.event",
    record: {
      $type: "community.lexicon.calendar.event",
      name: "Spike: Kona Freethinkers August Meetup",
      description: "Write-path spike event (om-qcufs). Not a real event.",
      createdAt: iso(now),
      startsAt: iso(nextWeek),
      mode: "community.lexicon.calendar.event#inperson",
      status: "community.lexicon.calendar.event#planned",
    },
  });
  show("A4 group writes calendar event", eventRef);
} catch (e) {
  show("A4 event write FAILED", String(e));
}

if (eventRef) {
  try {
    const rsvp = await createSpaceRecord(alice, {
      space: spaceUri,
      collection: "community.lexicon.calendar.rsvp",
      record: {
        $type: "community.lexicon.calendar.rsvp",
        subject: { uri: eventRef.uri, cid: eventRef.cid },
        status: "community.lexicon.calendar.rsvp#going",
        createdAt: iso(now),
      },
    });
    show("A5 alice RSVPs (into her repo in the space)", rsvp);
  } catch (e) {
    show("A5 alice RSVP FAILED", String(e));
  }
}

// The RSVP-visibility question: can BOB read the group's event and ALICE's RSVP?
show("A6 bob reads group repo (events)", await listRecords(bob, spaceUri, group.did, "community.lexicon.calendar.event"));
show("A7 bob reads alice repo (rsvps)", await listRecords(bob, spaceUri, alice.did, "community.lexicon.calendar.rsvp"));
// And the boundary: anonymous read of a member-list space must fail.
show("A8 anon reads group repo (expect 401)", await listRecords(anon, spaceUri, group.did, null));

// ---- Phase B: public-policy space (the discoverability probe) ----
const pubUri = formatSpaceUri({ authorityDid: group.did, type: SPACE_TYPE, skey: "kona-public" });
try {
  const created = await createSpace(group, { type: SPACE_TYPE, skey: "kona-public", policy: { kind: "public" } });
  show("B1 createSpace (public)", created);
  const ev = await createSpaceRecord(group, {
    space: pubUri,
    collection: "community.lexicon.calendar.event",
    record: {
      $type: "community.lexicon.calendar.event",
      name: "Spike: public open house",
      description: "Public-policy spike event (om-qcufs).",
      createdAt: iso(now),
      startsAt: iso(nextWeek),
      mode: "community.lexicon.calendar.event#inperson",
      status: "community.lexicon.calendar.event#planned",
    },
  });
  show("B2 group writes public event", ev);
} catch (e) {
  show("B1/B2 public space FAILED", String(e));
}

// "Any user may access": authenticated NON-member (bob was never added here) vs anonymous.
show("B3 bob (authed non-member) reads public space", await listRecords(bob, pubUri, group.did, "community.lexicon.calendar.event"));
show("B4 anon reads public space", await listRecords(anon, pubUri, group.did, "community.lexicon.calendar.event"));
