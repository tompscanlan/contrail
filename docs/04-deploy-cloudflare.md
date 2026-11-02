# Deploy to Cloudflare Workers

Turn the same local AppView into a public Worker backed by D1.

## Install

From the directory containing `contrail.config.ts`:

```bash
pnpm init
pnpm add @atmo-dev/contrail
pnpm add -D @atcute/lex-cli wrangler typescript
```

Add an ordered source to the config. Keep its epoch stable for the lifetime of this database:

```ts
// contrail.config.ts
import type { ContrailConfig } from "@atmo-dev/contrail";

const config: ContrailConfig = {
  namespace: "com.example",
  orderedSource: {
    source: "jetstream",
    epoch: "my-appview-jetstream-v2",
  },
  collections: {
    // ...your existing collections
  },
};

export default config;
```

Generate the public query Lexicons and their referenced record Lexicons:

```bash
pnpm contrail lexicons all --public
```

## Create the Worker

```ts
// worker.ts
import { createWorker } from "@atmo-dev/contrail/worker";
import config from "./contrail.config";
import { lexicons } from "./lexicons/generated";

export default createWorker(config, {
  lexicons,
  publicService: {
    endpoint: "https://my-appview.example.com",
  },
});
```

Use the Worker's actual `workers.dev` or custom-domain URL as `endpoint`.

Create `wrangler.jsonc`:

```jsonc
{
  "name": "my-appview",
  "main": "worker.ts",
  "compatibility_date": "2025-12-25",
  "observability": { "enabled": true },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "my-appview",
      "database_id": "PASTE_DATABASE_ID_HERE"
    }
  ],
  "triggers": { "crons": ["*/1 * * * *"] }
}
```

## Deploy and backfill

```bash
pnpm wrangler d1 create my-appview  # copy its ID into wrangler.jsonc
pnpm wrangler deploy
pnpm contrail backfill --remote
```

The one-minute cron keeps the AppView current. Check it with:

```bash
curl https://my-appview.example.com/status
curl 'https://my-appview.example.com/xrpc/com.example.event.listRecords?limit=10'
```

Finally, point the application from the previous guide at the deployment:

```bash
pnpx @atmo-dev/contrail connect https://my-appview.example.com
```

When the config changes, regenerate the Lexicons, deploy, backfill any new collections, and reconnect the client with `--update`.

## Settings from the environment

`contrail backfill` loads the config outside the Worker. When the config depends on settings, such as the relays and identity services of another atproto network, export it as a function of the environment. Commands that open a D1 binding (`backfill`, `changes`, and `dev` on a Wrangler project) call it with the Worker env that wrangler builds: `vars` from wrangler.jsonc, `.dev.vars` or `.env`, and the process environment when `CLOUDFLARE_INCLUDE_PROCESS_ENV=true`. Other commands call it with `process.env`.

```ts
// contrail.config.ts
import type { ContrailConfig } from "@atmo-dev/contrail";

export default (env: Record<string, unknown>): ContrailConfig => ({
  namespace: "com.example",
  collections: {
    // ...your existing collections
  },
  ...(env.RELAY_URLS ? { relays: String(env.RELAY_URLS).split(",") } : {}),
});
```

The Worker calls it with its own env:

```ts
// worker.ts
import { env } from "cloudflare:workers";
import { createWorker } from "@atmo-dev/contrail/worker";
import config from "./contrail.config";
import { lexicons } from "./lexicons/generated";

export default createWorker(config(env), { lexicons });
```

To backfill the local database that `wrangler dev --persist-to <dir>` uses, pass the same directory: `pnpm contrail backfill --persist-to <dir>`. Without it, local runs use `.wrangler/state`. Each run prints the database it writes and the relays it reads.

For optional outbox deliveries, feeds, and labels, see [advanced topics](./advanced/README.md).
