// om-qcufs managing-app gate: the thing a space's managingAppPolicy points at.
// Serves exactly two routes:
//   GET /.well-known/did.json  — did:web document, derived from the Host header,
//                                carrying the #spike_gate service entry
//   GET /xrpc/com.atproto.simplespace.checkUserAccess — the authorization gate:
//                                allowlist alice, deny everyone else
// Logs every gate call with the (decoded, NOT verified) service-auth claims so we
// can see what the authority PDS actually sends. Spike-grade: no signature check.
import { createServer } from "node:http";

const ALICE_DID = "did:plc:hkymspvcjhy6sbujuydfj7sv";
const PORT = 8787;

function decodeJwtNoVerify(auth) {
  if (!auth?.startsWith("Bearer ")) return null;
  try {
    const [h, p] = auth.slice(7).split(".");
    const dec = (s) => JSON.parse(Buffer.from(s, "base64url").toString());
    return { header: dec(h), payload: dec(p) };
  } catch {
    return null;
  }
}

createServer((req, res) => {
  const url = new URL(req.url, `https://${req.headers.host ?? "localhost"}`);

  if (url.pathname === "/.well-known/did.json") {
    const host = req.headers.host;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      "@context": ["https://www.w3.org/ns/did/v1"],
      id: `did:web:${host}`,
      service: [{
        id: "#spike_gate",
        type: "SpikeGateService",
        serviceEndpoint: `https://${host}`,
      }],
    }));
    console.log(`[${new Date().toISOString()}] served did.json for did:web:${host}`);
    return;
  }

  if (url.pathname === "/xrpc/com.atproto.simplespace.checkUserAccess") {
    const user = url.searchParams.get("user");
    const space = url.searchParams.get("space");
    const clientId = url.searchParams.get("clientId");
    const authorized = user === ALICE_DID;
    const claims = decodeJwtNoVerify(req.headers.authorization);
    console.log(`[${new Date().toISOString()}] checkUserAccess`, JSON.stringify({
      user, space, clientId, decision: authorized ? "AUTHORIZE" : "DENY",
      serviceAuth: claims ? { alg: claims.header?.alg, iss: claims.payload?.iss, aud: claims.payload?.aud, lxm: claims.payload?.lxm, exp: claims.payload?.exp } : "ABSENT",
    }));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ authorized }));
    return;
  }

  console.log(`[${new Date().toISOString()}] 404 ${req.method} ${url.pathname}`);
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "NotFound" }));
}).listen(PORT, "127.0.0.1", () => console.log(`gate listening on 127.0.0.1:${PORT}`));
