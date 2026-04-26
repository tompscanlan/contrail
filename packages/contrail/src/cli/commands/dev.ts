import { spawn } from "node:child_process";
import type { CAC } from "cac";
import { Contrail } from "../../contrail.js";
import type { Database } from "../../core/types.js";
import { promptYesNo, resolveAndLoadConfig } from "../shared.js";

interface DevOpts {
  config?: string;
  root: string;
  binding: string;
  cron: string;
  concurrency: number;
  ignoreWindow?: number;
  staleAfter: number;
  yes?: boolean;
}

export function registerDev(cli: CAC): void {
  cli
    .command(
      "dev",
      "Local wrangler dev + auto-trigger cron + backfill/refresh prompts"
    )
    .option("--config <path>", "Path to Contrail config file (TS or JS)")
    .option("--root <path>", "Project root for auto-detection (default: CWD)", {
      default: process.cwd(),
    })
    .option("--binding <name>", "D1 binding name in wrangler.jsonc", {
      default: "DB",
    })
    .option(
      "--cron <expr>",
      "Cron expression to fire against /__scheduled (default: every minute)",
      { default: "*/1 * * * *" }
    )
    .option(
      "--concurrency <n>",
      "Concurrency passed to backfill if prompted (default: 100)",
      { default: 100 }
    )
    .option(
      "--ignore-window <s>",
      "Refresh ignore-window in seconds, if prompted (default: server default)"
    )
    .option(
      "--stale-after <min>",
      "Prompt to refresh if the ingest cursor is older than this (default: 60)",
      { default: 60 }
    )
    .option("--yes, -y", "Accept all prompts without asking (CI-friendly)")
    .action(async (options: DevOpts) => {
      const config = await resolveAndLoadConfig(options);

      // Pre-flight: connect to local D1 via wrangler's platform proxy, inspect
      // state, prompt. Then dispose before starting wrangler dev so the two
      // miniflare processes don't fight over the sqlite file.
      const { getPlatformProxy } = await import("wrangler");
      const { env, dispose } = await getPlatformProxy();
      const db = (env as Record<string, unknown>)[options.binding] as
        | Database
        | undefined;

      if (db) {
        const contrail = new Contrail(config);
        await contrail.init(db);

        const hasBackfilled = await db
          .prepare("SELECT 1 FROM backfills WHERE completed = 1 LIMIT 1")
          .first();

        if (!hasBackfilled) {
          console.log("no backfilled users in the local DB yet.");
          if (
            await promptYesNo(
              "run backfill now? (takes a few minutes)",
              true,
              !!options.yes
            )
          ) {
            await contrail.backfillAll(
              { concurrency: Number(options.concurrency) },
              db
            );
          }
        } else {
          const staleAfterMs = Number(options.staleAfter) * 60_000;
          const row = await db
            .prepare("SELECT time_us FROM cursor WHERE id = 1")
            .first<{ time_us: number }>();
          if (row?.time_us) {
            const ageMs = Date.now() - Math.floor(row.time_us / 1000);
            if (ageMs > staleAfterMs) {
              const hrs = (ageMs / 3_600_000).toFixed(1);
              console.log(
                `ingest cursor is ${hrs}h old — you may have missed events.`
              );
              if (await promptYesNo("run refresh first?", true, !!options.yes)) {
                const ignoreWindowMs =
                  options.ignoreWindow !== undefined
                    ? Number(options.ignoreWindow) * 1000
                    : undefined;
                await contrail.refresh({ ignoreWindowMs }, db);
              }
            }
          }
        }
      }

      await dispose();

      // Start wrangler dev + fire /__scheduled on a loop so the cron actually
      // runs in local dev (wrangler's cron scheduler only works in deployed
      // production; --test-scheduled enables the manual-trigger endpoint).
      const cronUrl = `http://localhost:8787/__scheduled?cron=${encodeURIComponent(options.cron)}`;

      const wrangler = spawn("npx", ["wrangler", "dev", "--test-scheduled"], {
        stdio: "inherit",
        shell: process.platform === "win32",
        cwd: options.root,
      });

      // Give wrangler a few seconds to bind the port, then start the cron loop.
      const kickoff = setTimeout(() => {
        fetch(cronUrl).catch(() => {}); // fire-and-forget; first run
        console.log(`\nauto-ingest: firing ${cronUrl} every 60s\n`);
      }, 3_000);

      const interval = setInterval(() => {
        fetch(cronUrl).catch(() => {}); // wrangler may be restarting; swallow
      }, 60_000);

      const cleanup = () => {
        clearTimeout(kickoff);
        clearInterval(interval);
        try {
          wrangler.kill("SIGINT");
        } catch {
          /* ignore */
        }
      };
      process.on("SIGINT", cleanup);
      process.on("SIGTERM", cleanup);

      const code = await new Promise<number>((resolve) => {
        wrangler.on("exit", (c) => {
          clearTimeout(kickoff);
          clearInterval(interval);
          resolve(c ?? 0);
        });
      });
      process.exit(code);
    });
}
