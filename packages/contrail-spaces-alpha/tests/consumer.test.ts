import { describe, expect, it } from "vitest";
import {
  createSpace,
  formatSpacePermissionScope,
  listSimpleSpaceMembers,
  putSimpleSpaceMember,
  removeSimpleSpaceMember,
  spacesConsumerOAuthScopes,
  spacesIntegratedOAuthScopes,
  updateSimpleSpacePolicies,
  type AuthenticatedPdsSession,
} from "../src/consumer";

describe("consumer scopes", () => {
  it("requests Space writes and only exact provider methods", () => {
    const space = formatSpacePermissionScope({
      type: "garden.atmo.circle",
      skey: "self",
      collections: ["garden.atmo.circle.note"],
    });
    expect(space).toContain("space:garden.atmo.circle?");
    expect(space).toContain("collection=garden.atmo.circle.note");
    const scopes = spacesConsumerOAuthScopes({
      audience: "did:web:spaces.atmo.garden#spaces",
      namespace: "garden.atmo.circle",
      collections: ["garden.atmo.circle.note"],
      spaceType: "garden.atmo.circle",
      skey: "self",
    });
    expect(scopes[2]).toContain("aud=did:web:spaces.atmo.garden%23spaces");
    expect(scopes[2]).toContain("garden.atmo.circle.note.listSpaceRecords");
    expect(scopes[2]).toContain("garden.atmo.circle.listSpaces");
    expect(scopes[2]).toContain("garden.atmo.circle.subscribeSpace");
    expect(scopes[2]).not.toContain("notifyWrite");

    const integrated = spacesIntegratedOAuthScopes({
      collections: ["garden.atmo.circle.note"],
      spaceType: "garden.atmo.circle",
      skey: "self",
    });
    expect(integrated).toHaveLength(2);
    expect(integrated.some((scope) => scope.startsWith("rpc?"))).toBe(false);
  });

  it("uses the PDS-native member-list procedures", async () => {
    const calls: Array<{ path: string; body?: Record<string, unknown> }> = [];
    const session: AuthenticatedPdsSession = {
      did: "did:plc:alice",
      async handle(path, init) {
        calls.push({
          path,
          body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        });
        if (path.includes("listMembers")) {
          return Response.json({
            members: [{ did: "did:plc:bob", read: true, write: false }],
          });
        }
        return Response.json(path.includes("createSpace")
          ? { uri: "at://did:plc:alice/space/garden.atmo.circle/self" }
          : {});
      },
    };
    const space = "at://did:plc:alice/space/garden.atmo.circle/self";
    await createSpace(session, {
      type: "garden.atmo.circle",
      skey: "self",
      readPolicy: { kind: "member-list" },
      writePolicy: { kind: "managing-app", managingApp: "did:web:provider.test#spaces" },
    });
    await putSimpleSpaceMember(session, space, {
      did: "did:plc:bob",
      read: true,
      write: false,
    });
    expect((await listSimpleSpaceMembers(session, { space })).members).toEqual([
      { did: "did:plc:bob", read: true, write: false },
    ]);
    await removeSimpleSpaceMember(session, space, "did:plc:bob");
    await updateSimpleSpacePolicies(session, space, {
      writePolicy: { kind: "member-list" },
    });

    expect(calls[0].body).toMatchObject({
      readPolicy: { $type: "com.atproto.simplespace.defs#memberListPolicy" },
      writePolicy: {
        $type: "com.atproto.simplespace.defs#managingAppPolicy",
        managingApp: "did:web:provider.test#spaces",
      },
    });
    expect(calls[1].body).toEqual({
      space,
      did: "did:plc:bob",
      read: true,
      write: false,
    });
    // An omitted policy is left alone rather than reset to the other one.
    expect(calls[4].body).toEqual({
      space,
      writePolicy: { $type: "com.atproto.simplespace.defs#memberListPolicy" },
    });
    expect(calls.map((call) => call.path)).toEqual([
      "/xrpc/com.atproto.simplespace.createSpace",
      "/xrpc/com.atproto.simplespace.putMember",
      `/xrpc/com.atproto.simplespace.listMembers?space=${encodeURIComponent(space)}`,
      "/xrpc/com.atproto.simplespace.removeMember",
      "/xrpc/com.atproto.simplespace.updateSpace",
    ]);
  });
});