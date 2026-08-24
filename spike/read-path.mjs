// om-qcufs read-path spike: the delegation-token -> space-credential dance from
// #95's protocol.ts, driven against the two spaces write-path.mjs created.
// Tokens/credentials are never printed — only lengths and outcomes.
import { readFileSync } from "node:fs";
import {
  getDelegationToken,
  formatSpaceUri,
} from "../packages/contrail-spaces-alpha/dist/consumer.js";
import {
  exchangeSpaceCredential,
  listRepos,
} from "../packages/contrail-spaces-alpha/dist/index.js";

const BASE = "https://pds.opnmt.net";
const GROUP_DID = "did:plc:jcwgw6fcnb5vyoid7nz7sl26";
const ALICE_DID = "did:plc:hkymspvcjhy6sbujuydfj7sv";
const SPACE_TYPE = "net.openmeet.group";
const memberSpace = formatSpaceUri({ authorityDid: GROUP_DID, type: SPACE_TYPE, skey: "kona" });
const publicSpace = formatSpaceUri({ authorityDid: GROUP_DID, type: SPACE_TYPE, skey: "kona-public" });

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

// listRecords through the credential transport (DPoP), not a session Bearer.
async function listRecordsViaCredential(transport, space, repo, collection) {
  const params = new URLSearchParams({ space, repo });
  if (collection) params.set("collection", collection);
  const r = await transport.fetch(`${BASE}/xrpc/com.atproto.space.listRecords?${params}`);
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
}

async function credentialDance(name, session, space) {
  const delegation = await getDelegationToken(session, space);
  const transport = await exchangeSpaceCredential({
    authorityPds: BASE,
    delegationToken: delegation,
    spaceUri: space,
  });
  show(`${name}: credential obtained`, {
    tokenLength: transport.token.length,
    expiresAt: new Date(transport.expiresAt).toISOString(),
  });
  return transport;
}

const bob = await login("bob");
const mallory = await login("mallory");

// --- Bob (member) on the member-list space: the RSVP-visibility question ---
try {
  const t = await credentialDance("bob@member-space", bob, memberSpace);
  show("bob listRepos (writer set)", await listRepos(t, BASE, { space: memberSpace }));
  show("bob reads GROUP events", await listRecordsViaCredential(t, memberSpace, GROUP_DID, "community.lexicon.calendar.event"));
  show("bob reads ALICE rsvps", await listRecordsViaCredential(t, memberSpace, ALICE_DID, "community.lexicon.calendar.rsvp"));
} catch (e) {
  show("bob@member-space FAILED", String(e));
}

// --- Mallory (non-member) on the member-list space: must be refused ---
try {
  await credentialDance("mallory@member-space", mallory, memberSpace);
  show("mallory@member-space", "CREDENTIAL GRANTED — policy NOT enforced!");
} catch (e) {
  show("mallory@member-space refused (expected)", String(e));
}

// --- Mallory (non-member) on the PUBLIC space: publicPolicy = any user ---
try {
  const t = await credentialDance("mallory@public-space", mallory, publicSpace);
  show("mallory reads public events", await listRecordsViaCredential(t, publicSpace, GROUP_DID, "community.lexicon.calendar.event"));
} catch (e) {
  show("mallory@public-space FAILED", String(e));
}
