---
"@atmo-dev/contrail": minor
---

add `contrail dev` — local dev wrapper for cloudflare workers deployments.

replaces `wrangler dev --test-scheduled` + a separate cron-trigger script with one command. on start it:

1. connects to your local D1 via wrangler's `getPlatformProxy`, inspects state
2. prompts to run `backfillAll` if no completed backfills exist yet
3. prompts to run `refresh` if the ingest cursor is older than 60 minutes (configurable with `--stale-after`)
4. spawns `wrangler dev --test-scheduled`
5. fires `GET /__scheduled?cron=...` every 60 seconds so the cron actually runs in local dev (wrangler's scheduler only works in deployed production)

flags: `--cron <expr>` (default `"*/1 * * * *"`), `--stale-after <min>` (default 60), `--yes` to auto-accept prompts, plus the standard `--config` / `--root` / `--binding`.

prompts are skipped in non-TTY environments (default-declined).

also adds `--yes` to the CLI-wide arg parser.
