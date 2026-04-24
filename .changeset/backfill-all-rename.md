---
"@atmo-dev/contrail": minor
---

rename `contrail.sync()` → `contrail.backfillAll()` and emit progress via `config.logger` by default.

the method previously returned `{ discovered, backfilled }` but emitted no output, so callers had to wire up their own `onProgress`. it now logs discovery + throttled backfill progress + final summary through `config.logger` (defaults to `console`). supplying `onProgress` still takes over, and passing a no-op logger silences it.

also renames the internal `backfillAll` function (in `src/core/backfill.ts`) to `backfillPending` to reduce confusion with the new public method. not publicly exported, so no user-facing impact.

adds a `contrail` CLI bin with a `backfill` subcommand so workers deploys don't need a local script file at all:

```json
"scripts": {
  "backfill":        "contrail backfill --config src/config.ts",
  "backfill:remote": "contrail backfill --config src/config.ts --remote"
}
```

auto-detects `contrail.config.ts`, `app/config.ts`, or `src/lib/contrail/config.ts`; loads TS configs via `jiti` (no tsx hook required). flags: `--config`, `--remote`, `--binding <name>`, `--concurrency <n>`.

the underlying helper is also exported at `@atmo-dev/contrail/workers` for embedded use:

```ts
import { backfillAll } from "@atmo-dev/contrail/workers";
await backfillAll({ config, remote: true });
```

`wrangler` is an optional peer dep — only imported at runtime when the cli/helper is called.

breaking: `contrail.sync()` is gone; rename callsites to `contrail.backfillAll()`. signature and return shape unchanged.
