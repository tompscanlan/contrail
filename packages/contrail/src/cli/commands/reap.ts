import type { CAC } from "cac";
import type { CommunityAdapter } from "../../core/community/adapter.js";
import type { CredentialCipher } from "../../core/community/credentials.js";
import type { Database } from "../../core/types.js";
import {
  buildTombstoneOp,
  cidForOp,
  getLastOpCid,
  signTombstoneOp,
  submitTombstoneOp,
} from "../../core/community/plc.js";
import { promptYesNo, resolveAndLoadConfig } from "../shared.js";

interface ReapOpts {
  config?: string;
  root?: string;
  remote?: boolean;
  binding: string;
  attemptId?: string;
  allStuck?: boolean;
  dryRun?: boolean;
  yes?: boolean;
}

/** Minimal logger interface so `runReap` can be invoked from tests with
 *  silent stubs and from the CLI shim with `console`. */
export interface ReapLogger {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface RunReapOptions {
  adapter: CommunityAdapter;
  cipher: CredentialCipher;
  plcDirectory: string;
  fetch?: typeof fetch;
  logger: ReapLogger;
  /** Skip confirmation prompts. The CLI passes this when the user supplied
   *  --yes; tests always pass true since they don't have a TTY. */
  yes: boolean;
  attemptId?: string;
  allStuck?: boolean;
  dryRun?: boolean;
}

export interface RunReapResult {
  ok: boolean;
  /** Validation/precondition error, present when ok=false. */
  error?: string;
  /** Number of rows successfully reaped (PLC tombstone submitted + archived). */
  reaped: number;
  /** Number of rows skipped because of --dry-run. */
  dryRunSkipped: number;
  /** Number of rows that errored out during reap (activated row, PLC error, etc.). */
  errors: number;
}

/** Core reap logic, decoupled from the CAC plumbing so tests can drive it
 *  without going through `getPlatformProxy()`. */
export async function runReap(opts: RunReapOptions): Promise<RunReapResult> {
  const result: RunReapResult = {
    ok: true,
    reaped: 0,
    dryRunSkipped: 0,
    errors: 0,
  };

  // Safety default: an operator who omits the flag must NOT trigger
  // irrevocable PLC tombstones. Real action requires an explicit
  // `dryRun: false` (CLI: `--no-dry-run`).
  const dryRun = opts.dryRun ?? true;

  const hasAttemptId = !!opts.attemptId;
  const hasAllStuck = !!opts.allStuck;
  if (!hasAttemptId && !hasAllStuck) {
    return {
      ...result,
      ok: false,
      error: "Specify exactly one of --attempt-id <uuid> or --all-stuck.",
    };
  }
  if (hasAttemptId && hasAllStuck) {
    return {
      ...result,
      ok: false,
      error:
        "--attempt-id and --all-stuck are mutually exclusive; pass exactly one.",
    };
  }

  const rows = hasAttemptId
    ? await loadSingle(opts.adapter, opts.attemptId!)
    : await opts.adapter.listStuckAttempts();

  if (rows.length === 0) {
    opts.logger.log("No stuck provision_attempts to reap.");
    return result;
  }

  for (const row of rows) {
    if (row.status === "activated") {
      opts.logger.error(
        `Refusing to reap ${row.attemptId}: status is "activated"; reap will not tombstone live communities.`
      );
      result.errors += 1;
      continue;
    }

    opts.logger.log(
      `Reaping ${row.attemptId} (did=${row.did}, status=${row.status})`
    );

    if (!row.encryptedRotationKey) {
      opts.logger.error(
        `  no encrypted_rotation_key on ${row.attemptId}; cannot sign tombstone`
      );
      result.errors += 1;
      continue;
    }

    let rotationJwk: JsonWebKey;
    try {
      const decoded = await opts.cipher.decryptString(row.encryptedRotationKey);
      rotationJwk = JSON.parse(decoded) as JsonWebKey;
    } catch (err) {
      opts.logger.error(
        `  failed to decrypt rotation key for ${row.attemptId}: ${err instanceof Error ? err.message : err}`
      );
      result.errors += 1;
      continue;
    }

    let prev: string;
    try {
      prev = await getLastOpCid(opts.plcDirectory, row.did, {
        fetch: opts.fetch,
      });
    } catch (err) {
      opts.logger.error(
        `  failed to fetch last PLC op cid for ${row.did}: ${err instanceof Error ? err.message : err}`
      );
      result.errors += 1;
      continue;
    }

    const unsigned = buildTombstoneOp(prev);
    const signed = await signTombstoneOp(unsigned, rotationJwk);
    const opCid = await cidForOp(signed);

    if (dryRun) {
      opts.logger.log(
        `  [dry-run] would submit tombstone (op cid=${opCid}, prev=${prev})`
      );
      result.dryRunSkipped += 1;
      continue;
    }

    if (!opts.yes) {
      const confirmed = await promptYesNo(
        `submit PLC tombstone for ${row.did}?`,
        false,
        false
      );
      if (!confirmed) {
        opts.logger.log(`  skipped ${row.attemptId} (not confirmed)`);
        continue;
      }
    }

    try {
      await submitTombstoneOp(opts.plcDirectory, row.did, signed, {
        fetch: opts.fetch,
      });
    } catch (err) {
      opts.logger.error(
        `  PLC tombstone submit failed for ${row.did}: ${err instanceof Error ? err.message : err}`
      );
      result.errors += 1;
      continue;
    }

    try {
      await opts.adapter.archiveOrphanedAttempt(row.attemptId, {
        tombstoneOpCid: opCid,
      });
    } catch (err) {
      opts.logger.error(
        `  archive failed for ${row.attemptId} after tombstone submit: ${err instanceof Error ? err.message : err}`
      );
      result.errors += 1;
      continue;
    }

    result.reaped += 1;
  }

  opts.logger.log(
    `Reaped ${result.reaped} attempts (${result.dryRunSkipped} dry-run skipped, ${result.errors} errors).`
  );
  return result;
}

async function loadSingle(
  adapter: CommunityAdapter,
  attemptId: string
): Promise<Awaited<ReturnType<CommunityAdapter["listStuckAttempts"]>>> {
  const row = await adapter.getProvisionAttempt(attemptId);
  return row ? [row] : [];
}

export function registerReap(cli: CAC): void {
  cli
    .command(
      "reap",
      "Tombstone stuck provision_attempts rows in PLC and archive them"
    )
    .option("--config <path>", "Path to Contrail config file")
    .option("--root <path>", "Project root for auto-detection (default: CWD)")
    .option("--remote", "Use production D1 bindings")
    .option("--binding <name>", "D1 binding name in wrangler.jsonc", {
      default: "DB",
    })
    .option("--attempt-id <uuid>", "Reap a single attempt by ID")
    .option(
      "--all-stuck",
      "Reap every provision_attempts row that did not reach status=activated"
    )
    .option(
      "--dry-run",
      "Print what would be tombstoned without submitting to PLC (DEFAULT)"
    )
    .option(
      "--no-dry-run",
      "Actually submit tombstones to PLC. Irrevocable. Required for real runs."
    )
    .option("--yes", "Auto-confirm prompts")
    .action(async (options: ReapOpts) => {
      if (!options.attemptId && !options.allStuck) {
        console.error("Specify --attempt-id <uuid> or --all-stuck.");
        process.exit(1);
      }
      if (options.attemptId && options.allStuck) {
        console.error(
          "--attempt-id and --all-stuck are mutually exclusive; pass exactly one."
        );
        process.exit(1);
      }

      const config = await resolveAndLoadConfig(options);
      const community = config.community;
      if (!community) {
        console.error(
          "config.community is not set; reap requires a configured community module."
        );
        process.exit(1);
      }
      if (!community.plcDirectory) {
        console.error(
          "config.community.plcDirectory is required for `contrail reap`."
        );
        process.exit(1);
      }

      const { getPlatformProxy } = await import("wrangler");
      const { env, dispose } = await getPlatformProxy();
      try {
        const db = (env as Record<string, unknown>)[options.binding] as
          | Database
          | undefined;
        if (!db) {
          console.error(
            `D1 binding "${options.binding}" not found in wrangler env.`
          );
          process.exit(1);
        }

        // Lazy-import to avoid pulling adapter into the CLI startup path
        // for unrelated subcommands.
        const { CommunityAdapter } = await import(
          "../../core/community/adapter.js"
        );
        const { CredentialCipher } = await import(
          "../../core/community/credentials.js"
        );
        const adapter = new CommunityAdapter(db);
        const cipher = new CredentialCipher(community.masterKey);

        const result = await runReap({
          adapter,
          cipher,
          plcDirectory: community.plcDirectory,
          logger: console,
          yes: !!options.yes,
          attemptId: options.attemptId,
          allStuck: options.allStuck,
          dryRun: options.dryRun,
        });

        if (!result.ok) {
          console.error(result.error);
          process.exit(1);
        }
        if (result.errors > 0) {
          process.exit(1);
        }
      } finally {
        await dispose();
      }
    });
}
