import { expect, it } from "vitest";
import { listRepoOps, type SpaceCredentialTransport } from "../src/protocol";

it("listRepoOps resolves undefined when an OK body cannot be read", async () => {
  const transport = {
    fetch: async () =>
      new Response("<not json>", {
        headers: { "content-type": "application/json" },
      }),
  } as unknown as SpaceCredentialTransport;

  const page = await listRepoOps(transport, "https://writer.test", {
    space: "at://did:plc:alice/space/garden.atmo.circle/self",
    repo: "did:plc:bob",
    since: "1",
  });

  expect(page).toBeUndefined();
});
