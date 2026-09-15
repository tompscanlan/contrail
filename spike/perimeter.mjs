// om-qcufs run 5: the two tunnel-gated halves, one process.
//   PHASE ATTEST — positive client attestation: serve client-metadata.json +
//     JWKS on the tunnel host, mint a private_key_jwt attestation (ES256,
//     typ atproto-client-attestation+jwt, aud = <groupDid>#atproto_space_host),
//     and exchange a credential on an allowList space that names our client_id.
//     Plus: un-attested refusal on the same space, and a jti replay attempt.
//   PHASE NOTIFY — registerNotify as did:web:<tunnel-host>#spike_consumer,
//     write to the space, and receive the PDS's notifyWrite POST (service auth
//     logged, decoded-not-verified — spike grade).
//
// Usage: node spike/perimeter.mjs https://<something>.trycloudflare.com
// (start the local listener first? no — this script IS the listener on 8787;
//  the tunnel must point at 127.0.0.1:8787 and be up before deliveries land.)
// Tokens/credentials/keys are never printed.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { webcrypto, randomBytes } from "node:crypto";
import {
  getDelegationToken,
  formatSpaceUri,
} from "../packages/contrail-spaces-alpha/dist/consumer.js";
import {
  exchangeSpaceCredential,
  registerNotify,
  listRepos,
} from "../packages/contrail-spaces-alpha/dist/index.js";

const PUBLIC_ORIGIN = process.argv[2]?.replace(/\/+$/, "");
if (!PUBLIC_ORIGIN?.startsWith("https://")) {
  console.error("usage: node spike/perimeter.mjs https://<tunnel-host>");
  process.exit(2);
}
const HOST = new URL(PUBLIC_ORIGIN).host;
const CLIENT_ID = `${PUBLIC_ORIGIN}/client-metadata.json`;
const SERVICE_ID = `did:web:${HOST}#spike_consumer`;

const BASE = "https://pds.opnmt.net";
const GROUP_DID = "did:plc:jcwgw6fcnb5vyoid7nz7sl26";
const SPACE_TYPE = "net.openmeet.group";
const EVENT = "community.lexicon.calendar.event";
const attestSpace = formatSpaceUri({ authorityDid: GROUP_DID, type: SPACE_TYPE, skey: "kona-attest" });
const kona = formatSpaceUri({ authorityDid: GROUP_DID, type: SPACE_TYPE, skey: "kona" });
const SPACE_HOST_AUD = `${GROUP_DID}#atproto_space_host`; // spaceHostAud()

// --- attestation key + minting ---------------------------------------------
const { subtle } = webcrypto;
const keyPair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
const publicJwk = { ...(await subtle.exportKey("jwk", keyPair.publicKey)), kid: "spike-attest-1", use: "sig", alg: "ES256" };
delete publicJwk.ext; delete publicJwk.key_ops;

const b64url = (data) =>
  Buffer.from(typeof data === "string" ? data : JSON.stringify(data)).toString("base64url");

async function mintAttestation({ jti } = {}) {
  const iat = Math.floor(Date.now() / 1000);
  const header = { alg: "ES256", typ: "atproto-client-attestation+jwt", kid: "spike-attest-1" };
  const payload = {
    iss: CLIENT_ID, sub: CLIENT_ID, aud: SPACE_HOST_AUD,
    iat, exp: iat + 60, jti: jti ?? randomBytes(16).toString("hex"),
  };
  const signingInput = `${b64url(header)}.${b64url(payload)}`;
  const sig = await subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, keyPair.privateKey, Buffer.from(signingInput),
  );
  return { jwt: `${signingInput}.${Buffer.from(sig).toString("base64url")}`, jti: payload.jti };
}

// --- the public server (tunnel target) --------------------------------------
const deliveries = [];
function decodeJwtNoVerify(auth) {
  if (!auth?.startsWith("Bearer ")) return null;
  try {
    const [h, p] = auth.slice(7).split(".");
    const dec = (s) => JSON.parse(Buffer.from(s, "base64url").toString());
    return { header: dec(h), payload: dec(p) };
  } catch { return null; }
}
createServer((req, res) => {
  const url = new URL(req.url, `https://${req.headers.host ?? "localhost"}`);
  const stamp = new Date().toISOString();
  if (url.pathname === "/.well-known/did.json") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      "@context": ["https://www.w3.org/ns/did/v1"],
      id: `did:web:${req.headers.host}`,
      service: [{ id: "#spike_consumer", type: "AtprotoSpaceSyncer", serviceEndpoint: `https://${req.headers.host}` }],
    }));
    console.log(`[${stamp}] served did.json (did:web:${req.headers.host})`);
    return;
  }
  if (url.pathname === "/client-metadata.json") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      client_id: CLIENT_ID,
      client_name: "om-qcufs spike consumer",
      redirect_uris: [`${PUBLIC_ORIGIN}/callback`],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "private_key_jwt",
      token_endpoint_auth_signing_alg: "ES256",
      dpop_bound_access_tokens: true,
      jwks: { keys: [publicJwk] },
    }));
    console.log(`[${stamp}] served client-metadata.json`);
    return;
  }
  if (url.pathname === "/xrpc/com.atproto.space.notifyWrite" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { /* keep raw */ }
      const claims = decodeJwtNoVerify(req.headers.authorization);
      deliveries.push({ at: stamp, body: parsed ?? body, auth: claims });
      console.log(`[${stamp}] notifyWrite DELIVERED`, JSON.stringify({
        body: parsed ?? body,
        serviceAuth: claims
          ? { alg: claims.header?.alg, iss: claims.payload?.iss, aud: claims.payload?.aud, lxm: claims.payload?.lxm }
          : "ABSENT",
      }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    return;
  }
  console.log(`[${stamp}] 404 ${req.method} ${url.pathname}`);
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "NotFound" }));
}).listen(8787, "127.0.0.1", () => console.log(`listening on 127.0.0.1:8787 as ${PUBLIC_ORIGIN}`));

// SPIKE_SERVE_ONLY=1: boot just the HTTP server (local smoke test / pre-tunnel).
if (process.env.SPIKE_SERVE_ONLY) {
  console.log("serve-only mode; driver skipped");
  await new Promise(() => {});
}

// --- pds plumbing ------------------------------------------------------------
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
  return { status: r.status, body: await r.json().catch(() => ({})) };
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
async function tryExchange(session, space, clientAttestation) {
  try {
    const delegation = await getDelegationToken(session, space);
    const transport = await exchangeSpaceCredential({
      authorityPds: BASE, delegationToken: delegation, spaceUri: space,
      ...(clientAttestation ? { clientAttestation } : {}),
    });
    return { granted: true, transport };
  } catch (e) {
    return { granted: false, error: String(e) };
  }
}

const group = await login("group");
const bob = await login("bob");

// sanity: the tunnel must serve our metadata before the PDS can fetch it
const probe = await fetch(CLIENT_ID).then((r) => r.status).catch((e) => String(e));
check("tunnel serves client-metadata.json", probe === 200, `status ${probe}`);
if (probe !== 200) { console.log("tunnel not reachable — aborting"); process.exit(1); }

// --- PHASE ATTEST ------------------------------------------------------------
const created = await xrpc(group, "com.atproto.simplespace.createSpace", {
  type: SPACE_TYPE, skey: "kona-attest",
  policy: { $type: "com.atproto.simplespace.defs#publicPolicy" },
  appAccess: { $type: "com.atproto.simplespace.defs#allowList", allowed: [CLIENT_ID] },
});
check("allowList space kona-attest created (allowed = our tunnel client_id)",
  created.status === 200, JSON.stringify(created.body));

const bare = await tryExchange(bob, attestSpace);
check("un-attested exchange still refused on this space", !bare.granted, bare.error);

const att1 = await mintAttestation();
const attested = await tryExchange(bob, attestSpace, att1.jwt);
show("bob exchange WITH attestation", attested.granted ? { granted: true } : attested);
check("ATTESTED exchange GRANTED (the positive half)", attested.granted, attested.error);

if (attested.granted) {
  try {
    const repos = await listRepos(attested.transport, BASE, { space: attestSpace });
    check("credential from attested exchange actually works (listRepos)",
      Array.isArray(repos.repos), `${repos.repos?.length ?? "?"} repos`);
  } catch (e) {
    check("credential from attested exchange actually works (listRepos)", false, String(e));
  }
}

const replay = await tryExchange(bob, attestSpace, att1.jwt);
check("REPLAYED attestation (same jti) refused", !replay.granted, replay.error);

const att2 = await mintAttestation();
const fresh = await tryExchange(bob, attestSpace, att2.jwt);
check("fresh attestation granted again (replay guard is jti-scoped)", fresh.granted, fresh.error);

const delAttest = await xrpc(group, "com.atproto.simplespace.deleteSpace", { space: attestSpace });
check("cleanup: kona-attest deleted", delAttest.status === 200, JSON.stringify(delAttest.body));

// --- PHASE NOTIFY ------------------------------------------------------------
const konaEx = await tryExchange(bob, kona);
check("kona credential for registerNotify", konaEx.granted, konaEx.error);
const reg = await registerNotify(konaEx.transport, BASE, { space: kona, service: SERVICE_ID });
show("registerNotify", reg);
check("registerNotify accepted (expiresAt returned)", typeof reg?.expiresAt === "string", JSON.stringify(reg));

// trigger: update the existing kona event
const evList = await (await group.handle(
  `/xrpc/com.atproto.space.listRecords?${new URLSearchParams({ space: kona, repo: GROUP_DID, collection: EVENT })}`,
)).json();
const ev = evList.records[0];
const wrote = await xrpc(group, "com.atproto.space.putRecord", {
  space: kona, repo: GROUP_DID, collection: EVENT, rkey: ev.rkey, validate: false,
  record: { ...ev.value, description: `notify trigger ${new Date().toISOString()} (om-qcufs run 5)` },
});
check("trigger write landed", wrote.status === 200, JSON.stringify(wrote.body).slice(0, 120));

// wait up to 30s for the PDS to deliver
const t0 = Date.now();
while (deliveries.length === 0 && Date.now() - t0 < 30_000) {
  await new Promise((resolve) => setTimeout(resolve, 500));
}
show("deliveries received", deliveries);
const d = deliveries[0];
check("notifyWrite delivered to our did:web service", !!d, `${deliveries.length} delivery(ies), waited ${Date.now() - t0}ms`);
if (d) {
  check("delivery names the right space + repo",
    d.body?.space === kona && d.body?.repo === GROUP_DID, JSON.stringify(d.body).slice(0, 200));
  check("delivery carries service auth addressed to us (aud = our service id, lxm = notifyWrite)",
    d.auth?.payload?.aud === SERVICE_ID && d.auth?.payload?.lxm === "com.atproto.space.notifyWrite" &&
    d.auth?.payload?.iss === GROUP_DID,
    JSON.stringify({ iss: d.auth?.payload?.iss, aud: d.auth?.payload?.aud, lxm: d.auth?.payload?.lxm }));
}

// cleanup: unregister so the PDS doesn't keep delivering to a dead tunnel
const unreg = await konaEx.transport.fetch(`${BASE}/xrpc/com.atproto.space.unregisterNotify`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ space: kona, service: SERVICE_ID }),
});
check("cleanup: unregisterNotify", unreg.ok, `status ${unreg.status}`);

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
