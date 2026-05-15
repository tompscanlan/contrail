import { describe, it, expect } from "vitest";
import {
  PlcDidDocumentResolver,
  CompositeDidDocumentResolver,
  WebDidDocumentResolver,
} from "@atcute/identity-resolver";
import { buildVerifier } from "../src/core/spaces/auth";
import type { AuthorityConfig } from "../src/core/spaces/types";

const CUSTOM_PLC = "http://custom-plc.test";

function makeAuthority(overrides: Partial<AuthorityConfig> = {}): AuthorityConfig {
  return {
    type: "tools.atmo.event.space",
    serviceDid: "did:web:authority.test",
    ...overrides,
  } as AuthorityConfig;
}

// ServiceJwtVerifier from @atcute/xrpc-server@0.1.12 exposes the resolver as
// the public instance field `didDocResolver` (verified against
// node_modules/.../auth/jwt-verifier.d.ts). The plan's hint at `.resolver` was
// a guess — we use the real field here so the test verifies the resolver
// actually wired into the verifier instance.
describe("buildVerifier resolver precedence", () => {
  it("uses AuthorityConfig.resolver when provided (most-specific wins)", () => {
    const specific = new CompositeDidDocumentResolver({
      methods: {
        plc: new PlcDidDocumentResolver({ apiUrl: "http://specific.test" }),
        web: new WebDidDocumentResolver(),
      },
    });
    const network = new CompositeDidDocumentResolver({
      methods: {
        plc: new PlcDidDocumentResolver({ apiUrl: CUSTOM_PLC }),
        web: new WebDidDocumentResolver(),
      },
    });
    const verifier = buildVerifier(makeAuthority({ resolver: specific }), {
      resolver: network,
    });
    expect(verifier.didDocResolver).toBe(specific);
  });

  it("falls back to networkOverrides.resolver when authority resolver is absent", () => {
    const network = new CompositeDidDocumentResolver({
      methods: {
        plc: new PlcDidDocumentResolver({ apiUrl: CUSTOM_PLC }),
        web: new WebDidDocumentResolver(),
      },
    });
    const verifier = buildVerifier(makeAuthority(), { resolver: network });
    expect(verifier.didDocResolver).toBe(network);
  });

  it("falls back to default composite when both are absent", () => {
    const verifier = buildVerifier(makeAuthority(), {});
    expect(verifier.didDocResolver).toBeInstanceOf(CompositeDidDocumentResolver);
  });

  it("treats omitted second arg the same as empty networkOverrides (backward-compat)", () => {
    const verifier = buildVerifier(makeAuthority());
    expect(verifier.didDocResolver).toBeInstanceOf(CompositeDidDocumentResolver);
  });
});
