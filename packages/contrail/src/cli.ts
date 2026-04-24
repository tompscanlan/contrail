#!/usr/bin/env node
/**
 * contrail — CLI for one-off operations against a contrail deployment.
 *
 * Usage:
 *   contrail backfill [--remote] [--binding DB] [--config path]
 *   contrail refresh  [--remote] [--ignore-window 60s] [--by-collection]
 *
 * Config auto-detects at contrail.config.ts, src/contrail.config.ts,
 * src/lib/contrail.config.ts, or app/contrail.config.ts (first match wins).
 */
import { findConfigFile, loadConfig, CONFIG_CANDIDATES_MESSAGE } from "./cli-config.js";
import { backfillAll, refresh } from "./workers/backfill.js";
import type { CollectionStats, RefreshResult } from "./core/refresh.js";

type Subcommand = "backfill" | "refresh" | "help";

const USAGE = `contrail <subcommand> [options]

Subcommands:
  backfill     One-time bulk load from each known DID's PDS (resumable)
  refresh      Fresh sweep: reconcile PDS vs DB, report missing + stale
  help         Print this message

Options (backfill):
  --config <path>      Path to Contrail config file (TS or JS).
  --root <path>        Project root for auto-detection. Default: CWD.
  --remote             Use production D1 bindings.
  --binding <name>     D1 binding name in wrangler.jsonc. Default: "DB".
  --concurrency <n>    Passed to contrail.backfillAll(). Default: 100.

Options (refresh):
  --config <path>      Path to Contrail config file (TS or JS).
  --root <path>        Project root for auto-detection. Default: CWD.
  --remote             Use production D1 bindings.
  --binding <name>     D1 binding name in wrangler.jsonc. Default: "DB".
  --concurrency <n>    Passed to contrail.refresh(). Default: 50.
  --ignore-window <s>  Seconds of grace for stale-update detection. Default: 60.
  --by-collection      Print per-collection stats, not just totals.
`;

interface Args {
  cmd: Subcommand;
  config?: string;
  root: string;
  remote: boolean;
  binding: string;
  concurrency?: number;
  ignoreWindowMs?: number;
  byCollection: boolean;
}

function parseArgs(argv: string[]): Args {
  const args = argv.slice(2);
  const cmd = (args.shift() ?? "help") as Subcommand;
  let config: string | undefined;
  let root = process.cwd();
  let remote = false;
  let binding = "DB";
  let concurrency: number | undefined;
  let ignoreWindowMs: number | undefined;
  let byCollection = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--config") config = args[++i];
    else if (a === "--root") root = args[++i];
    else if (a === "--remote") remote = true;
    else if (a === "--binding") binding = args[++i];
    else if (a === "--concurrency") concurrency = parseInt(args[++i], 10);
    else if (a === "--ignore-window") ignoreWindowMs = parseInt(args[++i], 10) * 1000;
    else if (a === "--by-collection") byCollection = true;
    else if (a === "-h" || a === "--help")
      return {
        cmd: "help",
        config,
        root,
        remote,
        binding,
        concurrency,
        ignoreWindowMs,
        byCollection,
      };
  }
  return { cmd, config, root, remote, binding, concurrency, ignoreWindowMs, byCollection };
}

function resolveConfigPath(opts: Args): string | null {
  const p = findConfigFile(opts.root, opts.config);
  if (!p) {
    console.error(
      "Could not find a Contrail config. Pass --config <path> or place one at\n" +
        `  ${CONFIG_CANDIDATES_MESSAGE}`
    );
  }
  return p;
}

function formatStats(s: CollectionStats): string {
  return `${s.missing} missing, ${s.staleUpdates} stale updates, ${s.inSync} in sync`;
}

function printRefreshReport(result: RefreshResult, byCollection: boolean): void {
  console.log("");
  if (byCollection) {
    console.log("by collection:");
    const entries = Object.entries(result.byCollection).sort(([a], [b]) =>
      a.localeCompare(b)
    );
    for (const [nsid, stats] of entries) {
      if (stats.missing === 0 && stats.staleUpdates === 0 && stats.inSync === 0) continue;
      console.log(`  ${nsid}`);
      console.log(`    ${formatStats(stats)}`);
    }
    console.log("");
  }
  console.log("total:");
  console.log(`  ${formatStats(result.total)}`);
  console.log(`  ${result.usersScanned} users scanned` +
    (result.usersFailed ? `, ${result.usersFailed} failed` : "") +
    ` in ${(result.elapsedMs / 1000).toFixed(1)}s`);
  console.log(`  (ignore window: ${(result.ignoreWindowMs / 1000).toFixed(0)}s)`);
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv);

  if (opts.cmd === "help") {
    process.stdout.write(USAGE);
    return 0;
  }

  if (opts.cmd === "backfill") {
    const configPath = resolveConfigPath(opts);
    if (!configPath) return 1;
    const config = await loadConfig(configPath);
    await backfillAll({
      config,
      remote: opts.remote,
      binding: opts.binding,
      concurrency: opts.concurrency ?? 100,
    });
    return 0;
  }

  if (opts.cmd === "refresh") {
    const configPath = resolveConfigPath(opts);
    if (!configPath) return 1;
    const config = await loadConfig(configPath);
    const result = await refresh({
      config,
      remote: opts.remote,
      binding: opts.binding,
      concurrency: opts.concurrency ?? 50,
      ignoreWindowMs: opts.ignoreWindowMs,
    });
    printRefreshReport(result, opts.byCollection);
    return 0;
  }

  console.error(USAGE);
  return 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
