---
"@atmo-dev/contrail": minor
---

Let CLI backfill read the app's settings. A config may be exported as a function of the environment: `backfill`, `changes`, and Wrangler `dev` call it with the Worker env that wrangler builds (wrangler.jsonc `vars`, `.dev.vars` or `.env`, and the process env under `CLOUDFLARE_INCLUDE_PROCESS_ENV`), and other commands with `process.env`. `backfill` and `changes` take `--persist-to <dir>`, meaning what `wrangler dev --persist-to` means, and `backfill` prints the database it writes and the relays it reads. `openWranglerDatabase()` and a `persistTo` option on the Wrangler helpers expose the same for programmatic use. Object configs and runs without `--persist-to` are unchanged.
