// om-qcufs run-3 addendum: the created-then-DELETED variant of om-m2u6x F1.
// Expectation: op1 = create (cid set, value omitted — superseded by the delete),
// op2 = delete (cid null, exempt from the throw). The throw fires on op1.
import { readFileSync } from "node:fs";
import { createSqliteDatabase } from "../packages/contrail/dist/adapters/sqlite.js";
import { resolveConfig } from "../packages/contrail/dist/index.js";
import {
  SpacesSyncEngine, initSpacesStorage, ensureSpaceWatch, saveCredential,
  generateCredentialEncryptionKey, exchangeSpaceCredential, listRepoOps,
  getSpaceWatch, listRepoStates,
} from "../packages/contrail-spaces-alpha/dist/index.js";
import {
  getDelegationToken, createSpaceRecord, deleteSpaceRecord, formatSpaceUri,
} from "../packages/contrail-spaces-alpha/dist/consumer.js";

const BASE = "https://pds.opnmt.net";
const GROUP_DID = "did:plc:jcwgw6fcnb5vyoid7nz7sl26";
const EVENT = "community.lexicon.calendar.event";
const space = formatSpaceUri({ authorityDid: GROUP_DID, type: "net.openmeet.group", skey: "kona" });

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
  return { did: d.did, handle: (p, init = {}) => fetch(BASE + p, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${d.accessJwt}` } }) };
}

const bob = await login("bob");
const group = await login("group");
const transport = await exchangeSpaceCredential({
  authorityPds: BASE, delegationToken: await getDelegationToken(bob, space), spaceUri: space,
});

const warns = [];
const db = createSqliteDatabase(":memory:");
const projection = resolveConfig({
  namespace: "net.openmeet.spike", profiles: [],
  collections: { event: { collection: EVENT } },
});
await initSpacesStorage(db, projection);
const watch = await ensureSpaceWatch(db, { spaceUri: space });
const encryptionKey = await generateCredentialEncryptionKey();
await saveCredential(db, {
  spaceUri: space, generation: watch.generation, viewerDid: bob.did,
  encryptionKey, credential: transport.serialize(),
});
const engine = new SpacesSyncEngine(db, {
  projection,
  spaceTypes: { "net.openmeet.group": { collections: [EVENT], policy: "member-list" } },
  serviceAudience: "did:web:spike.openmeet.invalid#spike",
  credentialEncryptionKey: encryptionKey,
  notificationRegistration: "disabled",
  logger: { log: () => {}, warn: (...a) => warns.push(a.map(String).join(" ")), error: () => {} },
});

// Baseline sync (full recovery, expected), record the group rev.
await engine.reconcileSpace(space, { deadline: Date.now() + 120_000 });
const w = await getSpaceWatch(db, space);
const rev0 = (await listRepoStates(db, w)).find((s) => s.repoDid === GROUP_DID).rev;

// created-then-DELETED between syncs.
const created = await createSpaceRecord(group, {
  space, collection: EVENT,
  record: {
    $type: EVENT, name: "Spike: created-then-deleted repro",
    createdAt: new Date().toISOString(), startsAt: new Date(Date.now() + 864e5).toISOString(),
    mode: "community.lexicon.calendar.event#inperson", status: "community.lexicon.calendar.event#planned",
  },
});
const rkey = created.uri.split("/").pop();
await deleteSpaceRecord(group, { space, collection: EVENT, rkey });

const raw = await listRepoOps(transport, BASE, { space, repo: GROUP_DID, since: rev0, limit: 100 });
console.log("raw ops since baseline:", raw.ops.map((op) => ({
  rkey: op.rkey, cid: op.cid ? "set" : null, prev: op.prev ? "set" : null,
  value: op.value === undefined ? "OMITTED" : "present",
})));

warns.length = 0;
await engine.reconcileSpace(space, { deadline: Date.now() + 120_000 });
const fellBack = warns.some((x) => x.includes("fell back to recovery") && x.includes("omitted its record value"));
console.log(fellBack
  ? "PASS  created-then-deleted also triggers the omitted-value throw -> full CAR fallback"
  : `FAIL  no fallback observed; warns: ${warns.join(" | ") || "(none)"}`);
process.exit(fellBack ? 0 : 1);
