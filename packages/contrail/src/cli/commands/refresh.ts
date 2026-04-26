import type { CAC } from "cac";
import { refresh } from "../../workers/backfill.js";
import { printRefreshReport, resolveAndLoadConfig } from "../shared.js";

interface RefreshOpts {
  config?: string;
  root?: string;
  remote?: boolean;
  binding: string;
  concurrency: number;
  ignoreWindow?: number;
  byCollection?: boolean;
}

export function registerRefresh(cli: CAC): void {
  cli
    .command(
      "refresh",
      "Fresh sweep: reconcile PDS vs DB, report missing + stale"
    )
    .option("--config <path>", "Path to Contrail config file (TS or JS)")
    .option("--root <path>", "Project root for auto-detection (default: CWD)")
    .option("--remote", "Use production D1 bindings")
    .option("--binding <name>", "D1 binding name in wrangler.jsonc", {
      default: "DB",
    })
    .option("--concurrency <n>", "Passed to contrail.refresh()", {
      default: 50,
    })
    .option(
      "--ignore-window <s>",
      "Seconds of grace for stale-update detection (default: 60)"
    )
    .option("--by-collection", "Print per-collection stats, not just totals")
    .action(async (options: RefreshOpts) => {
      const config = await resolveAndLoadConfig(options);
      const ignoreWindowMs =
        options.ignoreWindow !== undefined
          ? Number(options.ignoreWindow) * 1000
          : undefined;
      const result = await refresh({
        config,
        remote: !!options.remote,
        binding: options.binding,
        concurrency: Number(options.concurrency),
        ignoreWindowMs,
      });
      printRefreshReport(result, !!options.byCollection);
    });
}
