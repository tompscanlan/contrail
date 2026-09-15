// om-gb7r8: classify om-m2u6x FINDING 5 — "exchangeSpaceCredential never checks
// cnf.jkt" — against pds.opnmt.net (throwaway spaces-alpha test PDS).
//
// The claim: protocol.ts:263-268 decodes the returned credential's payload and
// validates ONE claim, exp:
//     const claims = JSON.parse(...body.credential.split(".")[1]...) as { exp?: unknown };
//     if (typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now()) throw
// It never compares cnf.jkt against the ES256 key it just generated at
// protocol.ts:235 and is about to DPoP-sign every request with (`grep -rn
// 'cnf\|jkt'` over packages/contrail-spaces-alpha = zero hits). So the client
// will happily wrap a credential bound to somebody else's key around its own.
//
// Nothing is written to the server; every call below is a read.
//   PART 1  the honest baseline — does a real credential even carry cnf.jkt,
//           and is it bound to the key the client generated?
//   PART 2  SUBSTITUTION — feed a *real, validly-signed, unexpired* credential
//           (bob's, bound to key K1) back into a second exchangeSpaceCredential
//           call, which generates its own key K2. Accepted?
//   PART 3  the payoff the finding claims — what does the mis-bound transport
//           actually DO against a live PDS, at the protocol layer and inside the
//           sync engine? That failure mode is the severity evidence.
//   PART 4  a fully synthetic credential (bogus signature, far-future exp,
//           foreign cnf.jkt) — how far does the exp-only gate let it travel?
// The credential strings themselves are NEVER printed; only claim presence,
// thumbprint EQUALITY, and status codes.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
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
  getSpace,
  listRepoOps,
} from "../packages/contrail-spaces-alpha/dist/index.js";
import { getDelegationToken, formatSpaceUri } from "../packages/contrail-spaces-alpha/dist/consumer.js";

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

const b64url = (buf) => Buffer.from(buf).toString("base64url");
function decodeClaims(jwt) {
  return JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8"));
}
// RFC 7638 JWK thumbprint for an EC key: the required members, lexicographic, no whitespace.
function jwkThumbprint(jwk) {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  return createHash("sha256").update(canonical).digest("base64url");
}
// The public half only — `d` is never read out of the serialized key.
function publicJwkOf(transport) {
  const jwk = transport.key.publicJwk ?? transport.serialize().privateJwk;
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
}

const bob = await login("bob");

// --- PART 1: the honest baseline ---------------------------------------------
// Capture the credential the server really issues, without printing it.
let captured = null;
const capturingFetch = async (input, init) => {
  const response = await globalThis.fetch(input, init);
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.includes("com.atproto.space.getSpaceCredential")) {
    const body = await response.clone().json().catch(() => null);
    if (typeof body?.credential === "string") captured = body.credential;
  }
  return response;
};

const honest = await exchangeSpaceCredential({
  authorityPds: BASE,
  delegationToken: await getDelegationToken(bob, space),
  spaceUri: space,
  fetch: capturingFetch,
});
const honestClaims = captured ? decodeClaims(captured) : null;
const honestJkt = jwkThumbprint(publicJwkOf(honest));
show("PART 1: the honest credential's claims (values redacted, shape only)", {
  claimNames: honestClaims ? Object.keys(honestClaims).sort() : null,
  hasCnf: Boolean(honestClaims?.cnf),
  hasCnfJkt: typeof honestClaims?.cnf?.jkt === "string",
  expInFuture: typeof honestClaims?.exp === "number" && honestClaims.exp * 1000 > Date.now(),
  cnfJktMatchesTheKeyTheClientGenerated: honestClaims?.cnf?.jkt === honestJkt,
});
check("PART 1: the authority DOES issue a cnf.jkt-bound credential",
  typeof honestClaims?.cnf?.jkt === "string");
check("PART 1: an honest server binds cnf.jkt to the client's own fresh key",
  honestClaims?.cnf?.jkt === honestJkt,
  "so no MISMATCH ever arises in normal operation");
const honestRead = await getSpace(honest, BASE, space).then(() => "ok").catch((e) => String(e).slice(0, 120));
check("PART 1: the correctly-bound transport can read (control)", honestRead === "ok", honestRead);

// --- PART 2: substitution ----------------------------------------------------
// A second exchange whose response is bob's REAL credential — valid signature,
// unexpired, correct audience — but bound to K1, while this call mints K2.
const substituted = await exchangeSpaceCredential({
  authorityPds: BASE,
  delegationToken: await getDelegationToken(bob, space),
  spaceUri: space,
  fetch: async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("com.atproto.space.getSpaceCredential")) {
      return new Response(JSON.stringify({ credential: captured }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    return globalThis.fetch(input, init);
  },
}).then((t) => ({ accepted: true, transport: t })).catch((e) => ({ accepted: false, error: String(e) }));

show("PART 2: exchangeSpaceCredential handed a credential bound to a DIFFERENT key", {
  accepted: substituted.accepted,
  error: substituted.error ?? null,
});
check("FINDING 5 CONFIRMED: the client ACCEPTS a credential bound to another key",
  substituted.accepted, substituted.error);
let mismatchJkt = null;
if (substituted.accepted) {
  mismatchJkt = jwkThumbprint(publicJwkOf(substituted.transport));
  show("PART 2: binding of the accepted transport", {
    credentialCnfJkt_matches_transportKey: honestClaims?.cnf?.jkt === mismatchJkt,
    note: "the transport will DPoP-sign with K2 while presenting a credential bound to K1",
  });
  check("PART 2: the accepted credential is bound to a key this transport does NOT hold",
    honestClaims?.cnf?.jkt !== mismatchJkt,
    "exp was the only claim checked (protocol.ts:263-268)");
}

// --- PART 3: what the mis-bound transport actually does -----------------------
const attempts = [];
if (substituted.accepted) {
  for (const [label, run] of [
    ["getSpace", () => getSpace(substituted.transport, BASE, space)],
    ["listRepoOps", () => listRepoOps(substituted.transport, BASE, { space, repo: GROUP_DID, since: "2222222222222", limit: 5 })],
  ]) {
    const started = Date.now();
    try {
      await run();
      attempts.push({ call: label, outcome: "SUCCEEDED", ms: Date.now() - started });
    } catch (e) {
      attempts.push({
        call: label, outcome: "threw", ms: Date.now() - started,
        status: e?.status ?? null, code: e?.code ?? null,
        message: String(e?.message ?? e).slice(0, 140),
      });
    }
  }
}
show("PART 3a: live reads with the mis-bound credential", attempts);
check("PART 3a: the SERVER rejects the mis-bound credential (DPoP binding holds server-side)",
  attempts.length > 0 && attempts.every((a) => a.outcome === "threw"),
  JSON.stringify(attempts.map((a) => `${a.call}:${a.status ?? "?"}/${a.code ?? "?"}`)));
check("PART 3a: rejection is ONE clear error per call, not a retry loop",
  attempts.every((a) => a.ms < 5000),
  attempts.map((a) => `${a.call} ${a.ms}ms`).join(", "));

// Engine-level: what does a consumer running this credential experience?
const projection = resolveConfig({
  namespace: "net.openmeet.spike", profiles: [],
  collections: { event: { collection: EVENT }, rsvp: { collection: RSVP } },
});
const db = createSqliteDatabase(":memory:");
await initSpacesStorage(db, projection);
const watch0 = await ensureSpaceWatch(db, { spaceUri: space });
const encryptionKey = await generateCredentialEncryptionKey();
if (substituted.accepted) {
  await saveCredential(db, {
    spaceUri: space, generation: watch0.generation, viewerDid: bob.did, encryptionKey,
    credential: substituted.transport.serialize(),
  });
}
const engineWarns = [];
const engine = new SpacesSyncEngine(db, {
  projection,
  spaceTypes: { [SPACE_TYPE]: { collections: [EVENT, RSVP], policy: "member-list" } },
  serviceAudience: "did:web:spike.openmeet.invalid#spike",
  credentialEncryptionKey: encryptionKey,
  notificationRegistration: "disabled",
  logger: { log: () => {}, warn: (...a) => engineWarns.push(a.map(String).join(" ")), error: (...a) => engineWarns.push(a.map(String).join(" ")) },
});
const startedEngine = Date.now();
let engineThrew = null;
try { await engine.reconcileSpace(space, { deadline: Date.now() + 30_000 }); } catch (e) { engineThrew = String(e).slice(0, 160); }
const engineMs = Date.now() - startedEngine;
const afterWatch = await getSpaceWatch(db, space);
show("PART 3b: reconcileSpace driven by the mis-bound credential", {
  elapsedMs: engineMs,
  threw: engineThrew,
  watchStatus: afterWatch.status,
  watchLastError: afterWatch.lastError,
  nextReconcileInMs: afterWatch.nextReconcileAt ? afterWatch.nextReconcileAt - Date.now() : null,
  warns: engineWarns.map((w) => w.slice(0, 160)),
});
check("PART 3b: the engine PAUSES the watch rather than spinning",
  afterWatch.status === "paused", `status=${afterWatch.status}`);
check("PART 3b: the watch records the server's own diagnosis verbatim",
  /bound to/i.test(String(afterWatch.lastError ?? "")),
  `watch.lastError = ${JSON.stringify(afterWatch.lastError)}`);

// --- PART 4: a fully synthetic credential ------------------------------------
// Far-future exp, a cnf.jkt for a key nobody holds, and a signature that is not
// a signature. If the client's gate is exp-only, this gets wrapped too.
const fakeJwt = [
  b64url(JSON.stringify({ alg: "ES256", typ: "space-credential+jwt" })),
  b64url(JSON.stringify({
    iss: BASE, aud: "did:web:spike.openmeet.invalid#spike", sub: bob.did, space,
    exp: Math.floor(Date.now() / 1000) + 365 * 24 * 3600,
    cnf: { jkt: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
  })),
  b64url("not-a-signature"),
].join(".");
const synthetic = await exchangeSpaceCredential({
  authorityPds: BASE,
  delegationToken: await getDelegationToken(bob, space),
  spaceUri: space,
  fetch: async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("com.atproto.space.getSpaceCredential")) {
      return new Response(JSON.stringify({ credential: fakeJwt }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    return globalThis.fetch(input, init);
  },
}).then((t) => ({ accepted: true, transport: t })).catch((e) => ({ accepted: false, error: String(e) }));
show("PART 4: a wholly forged credential (bad signature, 1-year exp, foreign jkt)", {
  clientAccepted: synthetic.accepted,
  error: synthetic.error ?? null,
  expiresAt: synthetic.accepted ? new Date(synthetic.transport.expiresAt).toISOString() : null,
});
check("PART 4: the client accepts it too — exp is the ONLY gate",
  synthetic.accepted, synthetic.error);
let syntheticRead = null;
if (synthetic.accepted) {
  syntheticRead = await getSpace(synthetic.transport, BASE, space)
    .then(() => ({ outcome: "SUCCEEDED" }))
    .catch((e) => ({ outcome: "threw", status: e?.status ?? null, code: e?.code ?? null, message: String(e?.message ?? e).slice(0, 140) }));
  show("PART 4: the forged credential against the live PDS", syntheticRead);
  check("PART 4: the SERVER rejects the forgery — the client gate is not the security boundary",
    syntheticRead.outcome === "threw", JSON.stringify(syntheticRead));
  check("PART 4: the client will keep presenting it until its FAKE exp passes",
    synthetic.transport.expiresAt - Date.now() > 300 * 24 * 3600 * 1000,
    `client believes this credential is good until ${new Date(synthetic.transport.expiresAt).toISOString()}`);
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
