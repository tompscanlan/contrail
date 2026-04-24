/**
 * Wrangler-backed helpers for Cloudflare Workers deployments:
 *
 *   - `backfillAll` — one-time bulk load from scratch (uses the `backfills`
 *     state table to resume across runs).
 *   - `refresh` — reconcile every known DID's PDS against our DB, report
 *     what's missing or stale. Use after outages or long idle periods.
 *
 * Both dynamically import `wrangler` (optional peer dep) and wire it to
 * the user's D1 binding, then dispose the proxy on exit.
 */
import { Contrail } from "../contrail.js";
import type { ContrailConfig, Database } from "../core/types.js";
import type { BackfillAllOptions } from "../core/backfill.js";
import type { RefreshOptions, RefreshResult } from "../core/refresh.js";

interface WranglerCommon {
  config: ContrailConfig;
  /** Use production D1 bindings. Equivalent to
   *  `getPlatformProxy({ environment: "production" })`. */
  remote?: boolean;
  /** Name of the D1 binding in wrangler.jsonc. Default: `"DB"`. */
  binding?: string;
}

export interface BackfillAllViaWranglerOptions extends WranglerCommon {
  /** Passed through to `contrail.backfillAll()`. Default: 100. */
  concurrency?: number;
  /** Override the built-in progress logging. */
  onProgress?: BackfillAllOptions["onProgress"];
}

export interface RefreshViaWranglerOptions extends WranglerCommon {
  /** Passed through to `contrail.refresh()`. Default: 50. */
  concurrency?: number;
  /** Ignore-window for stale-update classification, in ms. Default: 60_000. */
  ignoreWindowMs?: number;
  /** Override the built-in progress logging. */
  onProgress?: RefreshOptions["onProgress"];
}

async function withWrangler<T>(
  opts: WranglerCommon,
  fn: (contrail: Contrail, db: Database) => Promise<T>
): Promise<T> {
  // Dynamic import so wrangler is only required when these helpers are
  // actually called — keeps the main package usable in runtimes without it.
  const { getPlatformProxy } = await import("wrangler");
  const binding = opts.binding ?? "DB";

  const { env, dispose } = await getPlatformProxy({
    environment: opts.remote ? "production" : undefined,
  });

  const db = (env as Record<string, unknown>)[binding] as Database | undefined;
  if (!db) {
    await dispose();
    throw new Error(
      `No binding named "${binding}" in wrangler env. Add a d1_databases ` +
        `entry to wrangler.jsonc, or pass { binding: "..." }.`
    );
  }

  try {
    const contrail = new Contrail(opts.config);
    await contrail.init(db);
    return await fn(contrail, db);
  } finally {
    await dispose();
  }
}

export async function backfillAll(
  opts: BackfillAllViaWranglerOptions
): Promise<{ discovered: number; backfilled: number }> {
  return withWrangler(opts, (contrail, db) =>
    contrail.backfillAll(
      { concurrency: opts.concurrency ?? 100, onProgress: opts.onProgress },
      db
    )
  );
}

export async function refresh(
  opts: RefreshViaWranglerOptions
): Promise<RefreshResult> {
  return withWrangler(opts, (contrail, db) =>
    contrail.refresh(
      {
        concurrency: opts.concurrency ?? 50,
        ignoreWindowMs: opts.ignoreWindowMs,
        onProgress: opts.onProgress,
      },
      db
    )
  );
}
