import { Contrail } from "../src/index";
import { createHandler } from "../src/server";
import { config } from "./config";

const contrail = new Contrail(config);
const handle = createHandler(contrail);

let initialized = false;

export default {
  async fetch(request: Request, env: { DB: D1Database }) {
    if (!initialized) {
      await contrail.init(env.DB);
      initialized = true;
    }
    return handle(request, env.DB);
  },

  async scheduled(
    _event: ScheduledEvent,
    env: { DB: D1Database },
    ctx: ExecutionContext
  ) {
    if (!initialized) {
      await contrail.init(env.DB);
      initialized = true;
    }
    ctx.waitUntil(contrail.ingest({}, env.DB));
  },
};
