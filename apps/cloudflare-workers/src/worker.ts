import { Contrail } from "@atmo-dev/contrail";
import { createHandler } from "@atmo-dev/contrail/server";
import { config } from "./contrail.config";

const contrail = new Contrail(config);
const handle = createHandler(contrail);
let ready = false;

export default {
  async fetch(req: Request, env: { DB: D1Database }) {
    if (!ready) { await contrail.init(env.DB); ready = true; } // create tables once
    return handle(req, env.DB);                                // xrpc routes
  },
  async scheduled(_ev: ScheduledEvent, env: { DB: D1Database }, ctx: ExecutionContext) {
    ctx.waitUntil(contrail.ingest({}, env.DB));                // pull new records
  },
};
