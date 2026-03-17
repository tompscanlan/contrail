import type { Hono } from "hono";
import type { ContrailConfig, Database, RecordRow, QueryableField } from "../types";
import { getCollectionNames } from "../types";
import { resolvedQueryable, resolvedRelationsMap } from "../queryable.generated";
import { queryRecords, getUsersByCollection } from "../db";
import { backfillUser } from "../backfill";
import { resolveHydrates } from "./hydrate";
import { resolveProfiles, collectDids } from "./profiles";
import { resolveActor } from "../identity";
import type { FormattedRecord } from "./helpers";
import { formatRecord, parseIntParam, fieldToParam } from "./helpers";

export function registerCollectionRoutes(
  app: Hono,
  db: Database,
  config: ContrailConfig
): void {
  for (const collection of getCollectionNames(config)) {
    const colConfig = config.collections[collection];
    const relations = colConfig.relations ?? {};
    const queryableFields: Record<string, QueryableField> =
      resolvedQueryable[collection] ?? colConfig.queryable ?? {};

    app.get(`/xrpc/${collection}.getRecords`, async (c) => {
      const params = new URL(c.req.url).searchParams;
      const limit = parseIntParam(params.get("limit"), 50);
      const cursor = parseIntParam(params.get("cursor"));
      const actor = params.get("actor") || params.get("did") || undefined;
      const wantProfiles = params.get("profiles") === "true";

      let did: string | undefined;
      if (actor) {
        const resolved = await resolveActor(db, actor);
        if (!resolved) return c.json({ error: "Could not resolve actor" }, 400);
        did = resolved;
        await backfillUser(db, did, collection, Date.now() + 10_000, config);
      }

      const filters: Record<string, string> = {};
      const rangeFilters: Record<string, { min?: string; max?: string }> = {};
      for (const [field, fieldConfig] of Object.entries(queryableFields)) {
        const param = fieldToParam(field);
        if (fieldConfig.type === "range") {
          const min = params.get(`${param}Min`);
          const max = params.get(`${param}Max`);
          if (min || max) {
            rangeFilters[field] = {};
            if (min) rangeFilters[field].min = min;
            if (max) rangeFilters[field].max = max;
          }
        } else {
          const value = params.get(param);
          if (value) filters[field] = value;
        }
      }

      const countFilters: Record<string, number> = {};
      const relMap = resolvedRelationsMap[collection] ?? {};
      for (const [relName, rel] of Object.entries(relations)) {
        const totalMin = parseIntParam(params.get(`${relName}CountMin`));
        if (totalMin != null) countFilters[rel.collection] = totalMin;
        const mapping = relMap[relName];
        if (mapping) {
          const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
          for (const [shortName, fullToken] of Object.entries(mapping.groups)) {
            const val = parseIntParam(params.get(`${relName}${capitalize(shortName)}CountMin`));
            if (val != null) countFilters[fullToken] = val;
          }
        }
      }

      const result = await queryRecords(db, config, {
        collection,
        did,
        limit,
        cursor,
        filters,
        rangeFilters,
        countFilters,
      });

      const rows = result.records;
      const hydrates = await resolveHydrates(
        db,
        relations,
        params.getAll("hydrate"),
        rows
      );

      const formattedRecords: FormattedRecord[] = rows.map((row) => {
        const formatted = formatRecord(row);
        flattenCounts(formatted, row.counts, collection, relations);
        const h = hydrates[row.uri];
        if (h) formatted.hydrates = h;
        return formatted;
      });

      const allDids = collectDids(rows, hydrates);
      const profileMap = wantProfiles
        ? await resolveProfiles(db, config, allDids)
        : undefined;

      return c.json({
        records: formattedRecords,
        cursor: result.cursor,
        ...(profileMap ? { profiles: Object.values(profileMap) } : {}),
      });
    });

    app.get(`/xrpc/${collection}.getRecord`, async (c) => {
      const uri = c.req.query("uri");
      if (!uri) return c.json({ error: "uri parameter required" }, 400);

      const row = await db
        .prepare(
          "SELECT uri, did, collection, rkey, cid, record, time_us, indexed_at FROM records WHERE uri = ? AND collection = ?"
        )
        .bind(uri, collection)
        .first<RecordRow>();

      if (!row) return c.json({ error: "Record not found" }, 404);

      const countRows = await db
        .prepare("SELECT type, count FROM counts WHERE uri = ?")
        .bind(uri)
        .all<{ type: string; count: number }>();

      const formatted = formatRecord(row);
      if (countRows.results?.length) {
        const counts: Record<string, number> = {};
        for (const cr of countRows.results) counts[cr.type] = cr.count;
        flattenCounts(formatted, counts, collection, relations);
      }

      const params = new URL(c.req.url).searchParams;
      const wantProfilesSingle = params.get("profiles") === "true";

      const hydrates = await resolveHydrates(
        db,
        relations,
        params.getAll("hydrate"),
        [row]
      );
      const h = hydrates[row.uri];
      if (h) formatted.hydrates = h;

      const allDids = collectDids([row], hydrates);
      const profileMap = wantProfilesSingle
        ? await resolveProfiles(db, config, allDids)
        : undefined;

      return c.json({
        ...formatted,
        ...(profileMap ? { profiles: Object.values(profileMap) } : {}),
      });
    });

    app.get(`/xrpc/${collection}.getUsers`, async (c) => {
      const limit = parseIntParam(c.req.query("limit"), 50) ?? 50;
      const cursor = parseIntParam(c.req.query("cursor"));
      return c.json(await getUsersByCollection(db, collection, limit, cursor));
    });

    app.get(`/xrpc/${collection}.getStats`, async (c) => {
      const row = await db
        .prepare(
          "SELECT COUNT(DISTINCT did) as unique_users, COUNT(*) as total_records, MAX(time_us) as last_record_time_us FROM records WHERE collection = ?"
        )
        .bind(collection)
        .first<{
          unique_users: number;
          total_records: number;
          last_record_time_us: number | null;
        }>();

      return c.json({
        collection,
        unique_users: row?.unique_users ?? 0,
        total_records: row?.total_records ?? 0,
        last_record_time_us: row?.last_record_time_us ?? null,
      });
    });

    for (const [queryName, handler] of Object.entries(
      colConfig.queries ?? {}
    )) {
      app.get(`/xrpc/${collection}.${queryName}`, async (c) => {
        const params = new URL(c.req.url).searchParams;
        return handler(db, params, config);
      });
    }
  }
}

function flattenCounts(
  formatted: FormattedRecord,
  counts: Record<string, number> | undefined,
  collection: string,
  relations: Record<string, any>
): void {
  if (!counts) return;
  const relMap = resolvedRelationsMap[collection] ?? {};
  const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

  // Build reverse lookups: collection NSID → relName (for totals), full token → field name (for groups)
  const collectionToRelName: Record<string, string> = {};
  const tokenToField: Record<string, string> = {};
  for (const [relName, mapping] of Object.entries(relMap)) {
    collectionToRelName[mapping.collection] = relName;
    for (const [shortName, fullToken] of Object.entries(mapping.groups)) {
      tokenToField[fullToken] = `${relName}${capitalize(shortName)}Count`;
    }
  }
  // Also map relations without groupBy (no entry in relMap)
  for (const [relName, rel] of Object.entries(relations)) {
    if (!collectionToRelName[rel.collection]) {
      collectionToRelName[rel.collection] = relName;
    }
  }

  for (const [type, count] of Object.entries(counts)) {
    if (collectionToRelName[type]) {
      formatted[`${collectionToRelName[type]}Count`] = count;
    } else if (tokenToField[type]) {
      formatted[tokenToField[type]] = count;
    }
  }
}
