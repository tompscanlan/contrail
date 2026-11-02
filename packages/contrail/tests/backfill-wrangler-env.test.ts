import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cac } from "cac";
import { registerBackfill } from "../src/cli/commands/backfill";

// The real `contrail backfill` command on a Wrangler project: wrangler's local
// D1 (workerd) and a fake relay that records which relay the backfill read.
describe("contrail backfill on a Wrangler project", () => {
  const cwd = process.cwd();
  const requests: string[] = [];
  let relay: Server;
  let relayUrl: string;
  let root: string;
  let logs: string[];

  beforeAll(async () => {
    relay = createServer((request, response) => {
      requests.push(request.url ?? "");
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ repos: [] }));
    });
    await new Promise<void>((done) => relay.listen(0, "127.0.0.1", done));
    relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise((done) => relay.close(done));
  });

  beforeEach(() => {
    requests.length = 0;
    root = mkdtempSync(join(tmpdir(), "contrail-backfill-env-"));
    writeFileSync(join(root, "package.json"), '{"type":"module"}');
    writeFileSync(
      join(root, "wrangler.jsonc"),
      JSON.stringify({
        name: "backfill-env-test",
        compatibility_date: "2025-12-25",
        vars: { FROM_WRANGLER: "wrangler-var" },
        d1_databases: [
          {
            binding: "DB",
            database_name: "backfill-env-test",
            database_id: "00000000-0000-0000-0000-000000000000",
          },
        ],
      }),
    );
    logs = [];
    vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });
    process.chdir(root);
  });
  afterEach(() => {
    process.chdir(cwd);
    vi.restoreAllMocks();
    delete process.env.CLOUDFLARE_INCLUDE_PROCESS_ENV;
    delete process.env.FROM_PROCESS;
    rmSync(root, { recursive: true, force: true });
  });

  async function backfill(...args: string[]) {
    const cli = cac("contrail");
    registerBackfill(cli);
    cli.parse(["node", "contrail", "backfill", ...args], { run: false });
    await cli.runMatchedCommand();
  }

  const discoveries = () =>
    requests.filter((url) =>
      url.startsWith("/xrpc/com.atproto.sync.listReposByCollection?"),
    );

  it(
    "gives a config function the Worker env and writes under --persist-to",
    async () => {
      writeFileSync(join(root, ".env"), `FROM_DOTENV=dotenv-var\nRELAY_URL=${relayUrl}\n`);
      process.env.CLOUDFLARE_INCLUDE_PROCESS_ENV = "true";
      process.env.FROM_PROCESS = "process-var";
      writeFileSync(
        join(root, "contrail.config.ts"),
        `import { writeFileSync } from "node:fs";
         export const config = (env: Record<string, unknown>) => {
           writeFileSync("env-seen.json", JSON.stringify({
             wrangler: env.FROM_WRANGLER,
             dotenv: env.FROM_DOTENV,
             process: env.FROM_PROCESS,
           }));
           return {
             namespace: "com.example",
             collections: { event: { collection: "com.example.event" } },
             relays: [String(env.RELAY_URL)],
           };
         };`,
      );

      await backfill("--persist-to", "custom-state");

      expect(JSON.parse(readFileSync(join(root, "env-seen.json"), "utf8"))).toEqual({
        wrangler: "wrangler-var",
        dotenv: "dotenv-var",
        process: "process-var",
      });
      expect(discoveries()).toHaveLength(1);
      expect(existsSync(join(root, "custom-state", "v3", "d1"))).toBe(true);
      expect(existsSync(join(root, ".wrangler", "state"))).toBe(false);
      expect(logs).toContain("backfill: writing local D1 binding DB in custom-state");
      expect(logs).toContain(`backfill: discovering repos from ${relayUrl}`);
    },
    60_000,
  );

  it(
    "keeps an object config and wrangler's default state directory",
    async () => {
      writeFileSync(
        join(root, "contrail.config.ts"),
        `export const config = {
           namespace: "com.example",
           collections: { event: { collection: "com.example.event" } },
           relays: [${JSON.stringify(relayUrl)}],
         };`,
      );

      await backfill();

      expect(discoveries()).toHaveLength(1);
      expect(existsSync(join(root, ".wrangler", "state", "v3", "d1"))).toBe(true);
      expect(logs).toContain("backfill: writing local D1 binding DB in .wrangler/state");
    },
    60_000,
  );
});
