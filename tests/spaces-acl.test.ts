import { describe, it, expect } from "vitest";
import { checkAccess, resolveCollectionPolicy } from "../src/core/spaces/acl";
import type { SpaceRow, SpaceMemberRow, SpacesConfig } from "../src/core/spaces/types";

function mkSpace(overrides: Partial<SpaceRow> = {}): SpaceRow {
  return {
    uri: "at://did:plc:alice/tools.atmo.event.space/s1",
    ownerDid: "did:plc:alice",
    type: "tools.atmo.event.space",
    key: "s1",
    serviceDid: "did:web:example.com#svc",
    memberListRef: null,
    appPolicyRef: null,
    policy: null,
    appPolicy: null,
    createdAt: 1,
    deletedAt: null,
    ...overrides,
  };
}

function mkMember(did: string): SpaceMemberRow {
  return { spaceUri: "x", did, perms: "member", addedAt: 1, addedBy: null };
}

const cfg: Pick<SpacesConfig, "defaultPolicies" | "defaultPolicy"> = {
  defaultPolicies: {
    "app.event.location": { read: "member", write: "owner" },
    "app.event.message":  { read: "member", write: "member" },
    "app.event.intake":   { read: "owner",  write: "member" },
    "app.event.ticket":   { read: "member-own", write: "owner" },
  },
};

describe("spaces acl", () => {
  it("denies when no policy resolves", () => {
    const s = mkSpace();
    const r = checkAccess({
      op: "read", collection: "unknown.ns", space: s,
      callerDid: "did:plc:alice", member: null, config: {},
    });
    expect(r.allow).toBe(false);
    expect((r as any).reason).toBe("no-policy");
  });

  it("falls back from space policy → defaultPolicies → defaultPolicy", () => {
    const s = mkSpace({ policy: { "override.ns": { read: "member", write: "owner" } } });
    expect(resolveCollectionPolicy(s, "override.ns", cfg)?.read).toBe("member");
    expect(resolveCollectionPolicy(s, "app.event.message", cfg)?.read).toBe("member");
    expect(resolveCollectionPolicy(s, "totally.new", { ...cfg, defaultPolicy: { read: "owner", write: "owner" }})?.read).toBe("owner");
  });

  it("owner can read/write/delete everything, even without a member row", () => {
    const s = mkSpace();
    for (const op of ["read", "write", "delete"] as const) {
      const r = checkAccess({
        op, collection: "app.event.location", space: s,
        callerDid: "did:plc:alice", member: null, config: cfg,
      });
      expect(r.allow).toBe(true);
    }
  });

  it("member read: members allowed, non-members denied", () => {
    const s = mkSpace();
    const bob = "did:plc:bob";
    const denied = checkAccess({
      op: "read", collection: "app.event.message", space: s,
      callerDid: bob, member: null, config: cfg,
    });
    expect(denied.allow).toBe(false);
    expect((denied as any).reason).toBe("not-member");

    const allowed = checkAccess({
      op: "read", collection: "app.event.message", space: s,
      callerDid: bob, member: mkMember(bob), config: cfg,
    });
    expect(allowed.allow).toBe(true);
  });

  it("owner-write: member cannot write, owner can", () => {
    const s = mkSpace();
    const bob = "did:plc:bob";
    const memberTry = checkAccess({
      op: "write", collection: "app.event.location", space: s,
      callerDid: bob, member: mkMember(bob), config: cfg,
    });
    expect(memberTry.allow).toBe(false);
    expect((memberTry as any).reason).toBe("not-owner");

    const ownerTry = checkAccess({
      op: "write", collection: "app.event.location", space: s,
      callerDid: "did:plc:alice", member: null, config: cfg,
    });
    expect(ownerTry.allow).toBe(true);
  });

  it("member-own read: member can read own, not others'", () => {
    const s = mkSpace();
    const bob = "did:plc:bob";
    const own = checkAccess({
      op: "read", collection: "app.event.ticket", space: s,
      callerDid: bob, member: mkMember(bob), targetAuthorDid: bob, config: cfg,
    });
    expect(own.allow).toBe(true);

    const other = checkAccess({
      op: "read", collection: "app.event.ticket", space: s,
      callerDid: bob, member: mkMember(bob), targetAuthorDid: "did:plc:charlie", config: cfg,
    });
    expect(other.allow).toBe(false);
    expect((other as any).reason).toBe("not-own-record");
  });

  it("owner-read: only owner reads intake answers", () => {
    const s = mkSpace();
    const bob = "did:plc:bob";
    const memberTry = checkAccess({
      op: "read", collection: "app.event.intake", space: s,
      callerDid: bob, member: mkMember(bob), config: cfg,
    });
    expect(memberTry.allow).toBe(false);
    expect((memberTry as any).reason).toBe("not-owner");

    const ownerTry = checkAccess({
      op: "read", collection: "app.event.intake", space: s,
      callerDid: "did:plc:alice", member: null, config: cfg,
    });
    expect(ownerTry.allow).toBe(true);
  });

  it("delete: author can delete own, owner can delete any, stranger denied", () => {
    const s = mkSpace();
    const bob = "did:plc:bob";
    const authorOwn = checkAccess({
      op: "delete", collection: "app.event.message", space: s,
      callerDid: bob, member: mkMember(bob), targetAuthorDid: bob, config: cfg,
    });
    expect(authorOwn.allow).toBe(true);

    const ownerDeleteAny = checkAccess({
      op: "delete", collection: "app.event.message", space: s,
      callerDid: "did:plc:alice", member: null, targetAuthorDid: bob, config: cfg,
    });
    expect(ownerDeleteAny.allow).toBe(true);

    const otherMember = checkAccess({
      op: "delete", collection: "app.event.message", space: s,
      callerDid: "did:plc:charlie", member: mkMember("did:plc:charlie"), targetAuthorDid: bob, config: cfg,
    });
    expect(otherMember.allow).toBe(false);
    expect((otherMember as any).reason).toBe("not-own-record");
  });

  it("app policy: allow-mode with apps[] denylists those apps", () => {
    const s = mkSpace({ appPolicy: { mode: "allow", apps: ["blocked.app"] } });
    const ok = checkAccess({
      op: "read", collection: "app.event.message", space: s,
      callerDid: "did:plc:alice", member: null, clientId: "fine.app", config: cfg,
    });
    expect(ok.allow).toBe(true);

    const blocked = checkAccess({
      op: "read", collection: "app.event.message", space: s,
      callerDid: "did:plc:alice", member: null, clientId: "blocked.app", config: cfg,
    });
    expect(blocked.allow).toBe(false);
    expect((blocked as any).reason).toBe("app-not-allowed");
  });

  it("app policy: deny-mode with apps[] allowlists those apps", () => {
    const s = mkSpace({ appPolicy: { mode: "deny", apps: ["trusted.app"] } });
    const ok = checkAccess({
      op: "read", collection: "app.event.message", space: s,
      callerDid: "did:plc:alice", member: null, clientId: "trusted.app", config: cfg,
    });
    expect(ok.allow).toBe(true);

    const blocked = checkAccess({
      op: "read", collection: "app.event.message", space: s,
      callerDid: "did:plc:alice", member: null, clientId: "anon.app", config: cfg,
    });
    expect(blocked.allow).toBe(false);
    expect((blocked as any).reason).toBe("app-not-allowed");
  });
});
