#!/usr/bin/env node
/**
 * contrail — CLI entrypoint.
 *
 * Subcommand implementations live in `./cli/commands/`; this file just wires
 * them into a single cac instance. See `contrail --help` for usage.
 */
import { cac } from "cac";
import { registerBackfill } from "./cli/commands/backfill.js";
import { registerRefresh } from "./cli/commands/refresh.js";
import { registerDev } from "./cli/commands/dev.js";
import { registerAppendScheduled } from "./cli/commands/append-scheduled.js";
import { resolveAndLoadConfig } from "./cli/shared.js";

const cli = cac("contrail");

registerBackfill(cli);
registerRefresh(cli);
registerDev(cli);
registerAppendScheduled(cli);

// `reap` lives in @atmo-dev/contrail-community after the PR #30 package split.
// Dynamically import so contrail has no compile-time edge into the community
// package (contrail-community already depends on contrail; a static import
// here would create a build cycle). When community isn't installed alongside,
// the `reap` subcommand simply isn't registered.
try {
  const mod = await import("@atmo-dev/contrail-community" as string);
  if (typeof mod.registerReap === "function") {
    mod.registerReap(cli, { resolveAndLoadConfig });
  }
} catch {
  // contrail-community not installed; `reap` unavailable.
}

cli.help();

try {
  cli.parse();
} catch (err) {
  console.error(err);
  process.exit(1);
}
