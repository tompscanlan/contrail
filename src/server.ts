import type { Contrail } from "./contrail";
import type { Database } from "./core/types";
import { createApp } from "./core/router";

/**
 * Create an HTTP handler from a Contrail instance.
 * Returns a standard (Request, db?) => Promise<Response> function.
 *
 * Usage:
 *   const handle = createHandler(contrail);
 *   // SvelteKit: export const GET = ({ request }) => handle(request);
 *   // Workers:   return handle(request, env.DB);
 */
export function createHandler(
  contrail: Contrail
): (request: Request, db?: Database) => Promise<Response> | Response {
  // Cache the Hono app when db is bound at construction
  let cachedApp: ReturnType<typeof createApp> | null = null;

  return (request: Request, db?: Database) => {
    const d = db ?? (contrail as any)._db;
    if (!d) throw new Error("No database provided. Pass db to Contrail constructor or to handler.");

    // If db is the same bound instance, reuse the Hono app
    if (!db && !cachedApp) {
      cachedApp = createApp(d, contrail.config);
    }

    const app = db ? createApp(d, contrail.config) : cachedApp!;
    return app.fetch(request);
  };
}
