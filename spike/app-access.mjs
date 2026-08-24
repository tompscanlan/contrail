// om-qcufs run 4: the app-perimeter half — appAccess allowList, live.
// Space kona-applist: publicPolicy (any user) + allowList appAccess, so every
// refusal below can only come from the APP gate.
// Positive attestation needs a publicly fetchable client-metadata URL (the PDS
// resolves iss = client_id), so this run covers enforcement + refusal shapes;
// the attested-consumer half needs a tunnel session.
import { readFileSync } from "node:fs";
import {
  getDelegationToken,
  formatSpaceUri,
} from "../packages/contrail-spaces-alpha/dist/consumer.js";
import { exchangeSpaceCredential } from "../packages/contrail-spaces-alpha/dist/index.js";

const BASE = "https://pds.opnmt.net";
const GROUP_DID = "did:plc:jcwgw6fcnb5vyoid7nz7sl26";
const SPACE_TYPE = "net.openmeet.group";
const SKEY = "kona-applist";
const space = formatSpaceUri({ authorityDid: GROUP_DID, type: SPACE_TYPE, skey: SKEY });
const controlSpace = formatSpaceUri({ authorityDid: GROUP_DID, type: SPACE_TYPE, skey: "kona" });
const ALLOWED_CLIENT = "https://spike-client.example/client-metadata.json"; // resolvable by nobody, deliberately

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
async function xrpc(session, method, body) {
  const r = await session.handle(`/xrpc/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const parsed = await r.json().catch(() => ({}));
  return { status: r.status, body: parsed };
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
async function tryExchange(label, session, targetSpace, clientAttestation) {
  try {
    const delegation = await getDelegationToken(session, targetSpace);
    await exchangeSpaceCredential({
      authorityPds: BASE, delegationToken: delegation, spaceUri: targetSpace,
      ...(clientAttestation ? { clientAttestation } : {}),
    });
    return { granted: true };
  } catch (e) {
    return { granted: false, error: String(e) };
  }
}

const group = await login("group");
const bob = await login("bob");

// --- setup: the allowList space -------------------------------------------
const created = await xrpc(group, "com.atproto.simplespace.createSpace", {
  type: SPACE_TYPE,
  skey: SKEY,
  policy: { $type: "com.atproto.simplespace.defs#publicPolicy" },
  appAccess: {
    $type: "com.atproto.simplespace.defs#allowList",
    allowed: [ALLOWED_CLIENT],
  },
});
show("createSpace kona-applist (public user policy + allowList app policy)", created);
check("allowList space created", created.status === 200, JSON.stringify(created.body));

const descResp = await group.handle(
  `/xrpc/com.atproto.simplespace.getSpace?${new URLSearchParams({ space })}`,
);
const desc = { status: descResp.status, body: await descResp.json().catch(() => ({})) };
show("getSpace description (what a consumer sees)", desc);
check("getSpace exposes the appAccess allowList to the authority",
  desc.status === 200 &&
  desc.body.appAccess?.$type === "com.atproto.simplespace.defs#allowList",
  JSON.stringify(desc.body.appAccess));

// --- control: same user, open-appAccess space, no attestation → granted ---
const control = await tryExchange("control", bob, controlSpace);
check("CONTROL bob@kona (open appAccess) granted without attestation", control.granted, control.error);

// --- the app gate ----------------------------------------------------------
const noAttest = await tryExchange("bob no attestation", bob, space);
show("bob exchange, NO attestation", noAttest);
check("allowList refuses un-attested exchange", !noAttest.granted, noAttest.error);
check("refusal names the APP gate (distinct from user gate)",
  !noAttest.granted && /App/i.test(noAttest.error ?? ""), noAttest.error);

const garbage = await tryExchange("bob garbage attestation", bob, space, "not-a-jwt-at-all");
show("bob exchange, garbage attestation", garbage);
check("garbage attestation refused", !garbage.granted, garbage.error);

// --- the authority-lockout question ---------------------------------------
// authorizeUser bypasses for the authority, but the app check runs FIRST and
// has no authority exemption in the source. Does the space owner lock
// themselves out of credential minting with a bad allowList?
const authority = await tryExchange("group (authority) no attestation", group, space);
show("AUTHORITY exchange on its own allowList space, no attestation", authority);
check("authority is NOT exempt from the app gate (misconfig = self-lockout)",
  !authority.granted, authority.error);

// --- cleanup ---------------------------------------------------------------
const deleted = await xrpc(group, "com.atproto.simplespace.deleteSpace", { space });
show("deleteSpace kona-applist", deleted);
check("cleanup: allowList space deleted", deleted.status === 200, JSON.stringify(deleted.body));

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
