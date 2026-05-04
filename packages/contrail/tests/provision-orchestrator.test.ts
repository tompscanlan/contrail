import { describe, it, expect, beforeEach } from "vitest";
import { initCommunitySchema } from "../src/core/community/schema";
import { CommunityAdapter } from "../src/core/community/adapter";
import { CredentialCipher } from "../src/core/community/credentials";
import { ProvisionOrchestrator } from "../src/core/community/provision";
import { generateKeyPair } from "../src/core/community/plc";
import { createTestDbWithSchema } from "./helpers";

const STUB_ROTATION_KEY = "did:key:zStubCallerRotationKeyForTests";

function mockPlc(opts: { lastOpCid?: string } = {}) {
  const ops: any[] = [];
  return {
    ops,
    async submit(did: string, op: any) {
      ops.push({ did, op });
      return { ok: true };
    },
    async getLastOpCid(_did: string) {
      return opts.lastOpCid ?? "bafyreistubgenesiscid";
    },
  };
}

function mockPds() {
  return {
    async createAccount() {
      return {
        did: "did:plc:x",
        handle: "h.test",
        accessJwt: "AT",
        refreshJwt: "RT",
      };
    },
    async getRecommendedDidCredentials() {
      return {
        rotationKeys: ["did:key:zPdsRot"],
        verificationMethods: { atproto: "did:key:zPdsSig" },
        alsoKnownAs: ["at://h.test"],
        services: {
          atproto_pds: {
            type: "AtprotoPersonalDataServer",
            endpoint: "https://pds.test",
          },
        },
      };
    },
    async activateAccount() {
      return;
    },
    async createAppPassword() {
      return { password: "minted-app-pw" };
    },
  };
}

describe("ProvisionOrchestrator", () => {
  let adapter: CommunityAdapter;
  let cipher: CredentialCipher;
  beforeEach(async () => {
    const db = await createTestDbWithSchema();
    await initCommunitySchema(db);
    cipher = new CredentialCipher(new Uint8Array(32).fill(99));
    adapter = new CommunityAdapter(db);
  });

  it("runs end-to-end and lands at status=activated", async () => {
    const orch = new ProvisionOrchestrator({
      adapter,
      cipher,
      plc: mockPlc(),
      pds: mockPds(),
      pdsDid: "did:web:pds.test",
    });

    const result = await orch.provision({
      attemptId: "a1",
      pdsEndpoint: "https://pds.test",
      handle: "h.test",
      email: "h@x.test",
      password: "p",
      inviteCode: "code",
      rotationKey: STUB_ROTATION_KEY,
    });

    expect(result.did).toBeTruthy();
    expect(result.status).toBe("activated");
    const row = await adapter.getProvisionAttempt("a1");
    expect(row?.status).toBe("activated");
    expect(row?.encryptedSigningKey).toBeTruthy();
    expect(row?.encryptedRotationKey).toBeTruthy();
    expect(row?.encryptedPassword).toBeTruthy();
  });

  it("seeds the community_sessions cache with the createAccount JWTs after activation", async () => {
    const orch = new ProvisionOrchestrator({
      adapter,
      cipher,
      plc: mockPlc(),
      pds: mockPds(),
      pdsDid: "did:web:pds.test",
    });

    const result = await orch.provision({
      attemptId: "a1",
      pdsEndpoint: "https://pds.test",
      handle: "h.test",
      email: "h@x.test",
      password: "p",
      inviteCode: "code",
      rotationKey: STUB_ROTATION_KEY,
    });

    const cached = await adapter.getSession(result.did);
    expect(cached).not.toBeNull();
    expect(cached?.accessJwt).toBe("AT");
    expect(cached?.refreshJwt).toBe("RT");
  });

  it("persists status=genesis_submitted before createAccount runs", async () => {
    let createCalled = false;
    const pds = {
      async createAccount() {
        // Inspect state at this exact moment.
        const row = await adapter.getProvisionAttempt("a1");
        expect(row?.status).toBe("genesis_submitted");
        createCalled = true;
        return {
          did: "did:plc:x",
          handle: "h.test",
          accessJwt: "AT",
          refreshJwt: "RT",
        };
      },
      async getRecommendedDidCredentials() {
        return {
          rotationKeys: [],
          verificationMethods: { atproto: "did:key:zSig" },
          alsoKnownAs: ["at://h.test"],
          services: {
            atproto_pds: { type: "x", endpoint: "https://pds.test" },
          },
        };
      },
      async activateAccount() {},
      async createAppPassword() {
        return { password: "minted" };
      },
    };

    const orch = new ProvisionOrchestrator({
      adapter,
      cipher,
      plc: mockPlc(),
      pds,
      pdsDid: "did:web:pds.test",
    });
    await orch.provision({
      attemptId: "a1",
      pdsEndpoint: "https://pds.test",
      handle: "h.test",
      email: "h@x.test",
      password: "p",
      rotationKey: STUB_ROTATION_KEY,
    });
    expect(createCalled).toBe(true);
  });

  it("marks last_error and rethrows when createAccount fails", async () => {
    const pds = {
      ...mockPds(),
      async createAccount() {
        throw new Error("createAccount 400: bad invite");
      },
    } as any;

    const orch = new ProvisionOrchestrator({
      adapter,
      cipher,
      plc: mockPlc(),
      pds,
      pdsDid: "did:web:pds.test",
    });

    await expect(
      orch.provision({
        attemptId: "a1",
        pdsEndpoint: "https://pds.test",
        handle: "h.test",
        email: "h@x.test",
        password: "p",
        rotationKey: STUB_ROTATION_KEY,
      })
    ).rejects.toThrow(/bad invite/);
    const row = await adapter.getProvisionAttempt("a1");
    expect(row?.status).toBe("genesis_submitted"); // last successful step
    expect(row?.lastError).toMatch(/bad invite/);
  });

  it("resumeFromAccountCreated submits an update op with prev=PLC log/last cid and lands at activated", async () => {
    // Pre-create a row at status=account_created with a real encrypted rotation key,
    // simulating recovery from a crash after createAccount succeeded.
    const rotationKey = await generateKeyPair();
    const encryptedRotation = await cipher.encrypt(
      JSON.stringify(rotationKey.privateJwk)
    );
    const encryptedSigning = await cipher.encrypt(JSON.stringify({}));
    await adapter.createProvisionAttempt({
      attemptId: "a1",
      did: "did:plc:x",
      pdsEndpoint: "https://pds.test",
      handle: "h.test",
      email: "h@x.test",
      encryptedSigningKey: encryptedSigning,
      encryptedRotationKey: encryptedRotation,
      callerRotationDidKey: rotationKey.publicDidKey,
    });
    await adapter.updateProvisionStatus("a1", "genesis_submitted");
    await adapter.updateProvisionStatus("a1", "account_created", {
      encryptedPassword: await cipher.encrypt("p"),
    });

    const stubCid = "bafyreitestcid";
    const plc = mockPlc({ lastOpCid: stubCid });
    let activateCalled = false;
    const pds = {
      async createAccount() {
        throw new Error("should not be called on resume");
      },
      async getRecommendedDidCredentials() {
        return {
          rotationKeys: ["did:key:zPdsRot"],
          verificationMethods: { atproto: "did:key:zPdsSig" },
          alsoKnownAs: ["at://h.test"],
          services: {
            atproto_pds: {
              type: "AtprotoPersonalDataServer",
              endpoint: "https://pds.test",
            },
          },
        };
      },
      async activateAccount(input: { pdsUrl: string; accessJwt: string }) {
        expect(input.accessJwt).toBe("AT");
        activateCalled = true;
      },
      async createAppPassword() {
        throw new Error("resume must not call createAppPassword");
      },
    };

    const orch = new ProvisionOrchestrator({
      adapter,
      cipher,
      plc,
      pds,
      pdsDid: "did:web:pds.test",
    });

    await orch.resumeFromAccountCreated("a1", "AT");

    // Verify the update op was submitted with prev = the cid we mocked.
    expect(plc.ops).toHaveLength(1);
    const submitted = plc.ops[0];
    expect(submitted.did).toBe("did:plc:x");
    expect(submitted.op.type).toBe("plc_operation");
    expect(submitted.op.prev).toBe(stubCid);
    // The signed update must merge the rotation key we stored with the recommended one.
    expect(submitted.op.rotationKeys).toContain(rotationKey.publicDidKey);
    expect(submitted.op.rotationKeys).toContain("did:key:zPdsRot");

    expect(activateCalled).toBe(true);
    const row = await adapter.getProvisionAttempt("a1");
    expect(row?.status).toBe("activated");
    expect(row?.activatedAt).toBeTruthy();
  });

  describe("resumeFromAccountCreated status guard", () => {
    /** Seed a row, walk it to the requested status, and return its
     *  attemptId. Rotation key is real so the resume path could decode it
     *  if the guard let it through. */
    async function seedAtStatus(
      attemptId: string,
      status:
        | "keys_generated"
        | "genesis_submitted"
        | "did_doc_updated"
        | "activated"
    ): Promise<void> {
      const rotationKey = await generateKeyPair();
      const encryptedRotation = await cipher.encrypt(
        JSON.stringify(rotationKey.privateJwk)
      );
      const encryptedSigning = await cipher.encrypt(JSON.stringify({}));
      await adapter.createProvisionAttempt({
        attemptId,
        did: `did:plc:${attemptId}`,
        pdsEndpoint: "https://pds.test",
        handle: `${attemptId}.pds.test`,
        email: `${attemptId}@x.test`,
        encryptedSigningKey: encryptedSigning,
        encryptedRotationKey: encryptedRotation,
        callerRotationDidKey: rotationKey.publicDidKey,
      });
      // Status-walk via updateProvisionStatus so timestamps are stamped
      // realistically.
      const path: Record<typeof status, string[]> = {
        keys_generated: [],
        genesis_submitted: ["genesis_submitted"],
        did_doc_updated: [
          "genesis_submitted",
          "account_created",
          "did_doc_updated",
        ],
        activated: [
          "genesis_submitted",
          "account_created",
          "did_doc_updated",
          "activated",
        ],
      };
      for (const next of path[status]) {
        await adapter.updateProvisionStatus(attemptId, next as any);
      }
    }

    /** A PDS stub whose every method throws — if the guard doesn't trip
     *  first, the test will fail loudly with an unrelated error. */
    function poisonedPds() {
      return {
        async createAccount() {
          throw new Error("createAccount should not run during guarded resume");
        },
        async getRecommendedDidCredentials() {
          throw new Error(
            "getRecommendedDidCredentials should not run during guarded resume"
          );
        },
        async activateAccount() {
          throw new Error(
            "activateAccount should not run during guarded resume"
          );
        },
        async createAppPassword() {
          throw new Error(
            "createAppPassword should not run during guarded resume"
          );
        },
      };
    }

    it("refuses when row is at status=activated", async () => {
      await seedAtStatus("guard-activated", "activated");
      const orch = new ProvisionOrchestrator({
        adapter,
        cipher,
        plc: mockPlc(),
        pds: poisonedPds(),
        pdsDid: "did:web:pds.test",
      });
      await expect(
        orch.resumeFromAccountCreated("guard-activated", "AT")
      ).rejects.toThrow(/account_created/);
      const row = await adapter.getProvisionAttempt("guard-activated");
      // Row untouched.
      expect(row?.status).toBe("activated");
    });

    it("refuses when row is at status=keys_generated", async () => {
      await seedAtStatus("guard-keys", "keys_generated");
      const orch = new ProvisionOrchestrator({
        adapter,
        cipher,
        plc: mockPlc(),
        pds: poisonedPds(),
        pdsDid: "did:web:pds.test",
      });
      await expect(
        orch.resumeFromAccountCreated("guard-keys", "AT")
      ).rejects.toThrow(/account_created/);
      const row = await adapter.getProvisionAttempt("guard-keys");
      expect(row?.status).toBe("keys_generated");
    });

    it("refuses when row is at status=genesis_submitted", async () => {
      await seedAtStatus("guard-genesis", "genesis_submitted");
      const orch = new ProvisionOrchestrator({
        adapter,
        cipher,
        plc: mockPlc(),
        pds: poisonedPds(),
        pdsDid: "did:web:pds.test",
      });
      await expect(
        orch.resumeFromAccountCreated("guard-genesis", "AT")
      ).rejects.toThrow(/account_created/);
      const row = await adapter.getProvisionAttempt("guard-genesis");
      expect(row?.status).toBe("genesis_submitted");
    });

    it("refuses when row is at status=did_doc_updated", async () => {
      await seedAtStatus("guard-didupd", "did_doc_updated");
      const orch = new ProvisionOrchestrator({
        adapter,
        cipher,
        plc: mockPlc(),
        pds: poisonedPds(),
        pdsDid: "did:web:pds.test",
      });
      await expect(
        orch.resumeFromAccountCreated("guard-didupd", "AT")
      ).rejects.toThrow(/account_created/);
      const row = await adapter.getProvisionAttempt("guard-didupd");
      expect(row?.status).toBe("did_doc_updated");
    });
  });
});
