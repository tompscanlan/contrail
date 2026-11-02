/**
 * Helpers shared across `contrail` subcommands.
 */
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  findConfigFile,
  findLexiconBundle,
  loadConfig,
  loadLexiconBundle,
  CONFIG_CANDIDATES_MESSAGE,
} from "../cli-config.js";
import type { ContrailConfig, Database } from "../core/types.js";
import { openWranglerDatabase } from "../workers/backfill.js";

export interface ConfigOpts {
  config?: string;
  root?: string;
}

/**
 * Resolve and load a ContrailConfig from CLI options. Exits with code 1 if no
 * config file is found, since every command except `append-scheduled` needs one.
 * A config exported as a function is called with `env`.
 */
export async function resolveConfig(
  opts: ConfigOpts,
  env: Record<string, unknown> = process.env,
): Promise<{ config: ContrailConfig; path: string }> {
  const root = opts.root ?? process.cwd();
  const path = findConfigFile(root, opts.config);
  if (!path) {
    throw new Error(
      "Could not find a Contrail config. Pass --config <path> or place one at\n" +
        `  ${CONFIG_CANDIDATES_MESSAGE}`,
    );
  }
  return { config: await loadConfig(path, env), path };
}

export async function resolveAndLoadConfig(
  opts: ConfigOpts,
  env: Record<string, unknown> = process.env,
): Promise<ContrailConfig> {
  return (await resolveConfig(opts, env)).config;
}

export interface DatabaseOpts {
  remote?: boolean;
  binding?: string;
  sqlite?: string;
  persistTo?: string;
}

export interface OpenedDatabase {
  db: Database;
  /** What a config exported as a function receives: the Worker env for a
   *  Wrangler binding, `process.env` for a SQLite file. */
  env: Record<string, unknown>;
  /** Names the database for log lines. */
  where: string;
  dispose(): Promise<void>;
}

/**
 * Open the database a command writes: an explicit SQLite file, or a Wrangler
 * D1 binding. Open it before loading the config, so a config exported as a
 * function reads the same env as the Worker that serves this database.
 */
export async function openDatabase(opts: DatabaseOpts): Promise<OpenedDatabase> {
  if (opts.sqlite && opts.remote) {
    throw new Error("--sqlite cannot be combined with --remote");
  }
  if (opts.sqlite && opts.persistTo) {
    throw new Error("--sqlite cannot be combined with --persist-to");
  }
  if (opts.sqlite) {
    const { createSqliteDatabase } = await import("../adapters/sqlite.js");
    return {
      db: createSqliteDatabase(opts.sqlite),
      env: process.env,
      where: `SQLite ${opts.sqlite}`,
      dispose: async () => {},
    };
  }
  const binding = opts.binding ?? "DB";
  const opened = await openWranglerDatabase(opts);
  return {
    ...opened,
    where: opts.remote
      ? `D1 binding ${binding} (production environment)`
      : `local D1 binding ${binding} in ${opts.persistTo ?? ".wrangler/state"}`,
  };
}

/** Load the standard generated/pinned bundle only when collection policy needs
 * runtime validation. */
export async function resolveValidationLexicons(
  opts: ConfigOpts,
  config: ContrailConfig,
): Promise<object[] | undefined> {
  if (!Object.values(config.collections).some((collection) => collection.validate === true)) {
    return undefined;
  }
  const root = opts.root ?? process.cwd();
  const path = findLexiconBundle(root);
  if (!path) {
    throw new Error(
      "validated collections require a generated Lexicon bundle; run `contrail lexicons all`",
    );
  }
  return loadLexiconBundle(path);
}

/**
 * Yes/no prompt that respects --yes (auto-accept) and falls back to the
 * provided default in non-TTY environments — the user isn't there to answer.
 */
export async function promptYesNo(
  question: string,
  defaultYes: boolean,
  autoYes: boolean
): Promise<boolean> {
  if (autoYes) return true;
  if (!input.isTTY) return false;
  const rl = createInterface({ input, output });
  try {
    const hint = defaultYes ? "[Y/n]" : "[y/N]";
    const ans = (await rl.question(`${question} ${hint} `)).trim().toLowerCase();
    if (ans === "") return defaultYes;
    return ans === "y" || ans === "yes";
  } finally {
    rl.close();
  }
}

/** Warn before omitting unresolved documents from a temporary source bundle. */
export async function confirmUnresolvedLexicons(
  nsids: readonly string[],
  autoYes: boolean,
): Promise<boolean> {
  console.warn("\nwarning: could not resolve these configured Lexicons:");
  for (const nsid of nsids) console.warn(`  - ${nsid}`);
  console.warn(
    "Continuing omits them and schemas that depend on them from the local " +
      "bundle. Directly affected record values will be generated as `unknown`.",
  );
  console.warn(
    "Collections with `validate: true` still cannot start without their complete Lexicon closure.",
  );
  return promptYesNo("continue without these Lexicons?", false, autoYes);
}
