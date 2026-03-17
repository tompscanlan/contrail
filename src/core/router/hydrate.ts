import type { RelationConfig, RecordRow, Database } from "../types";
import { getNestedValue, getRelationField } from "../types";
import { batchedInQuery, formatRecord } from "./helpers";

// --- Hydration: embed related records that point at the parent ---

export function parseHydrateParams(
  params: URLSearchParams,
  relations: Record<string, RelationConfig>
): Record<string, number> {
  const hydrates: Record<string, number> = {};
  const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  for (const relName of Object.keys(relations)) {
    const val = params.get(`hydrate${capitalize(relName)}`);
    if (val) {
      const limit = parseInt(val, 10);
      if (!isNaN(limit) && limit > 0) {
        hydrates[relName] = limit;
      }
    }
  }
  return hydrates;
}

// Per-relation hydrate result: array for ungrouped, Record<group, array> for grouped
export type HydrateResult = Record<string, Record<string, any[] | Record<string, any[]>>>;

export async function resolveHydrates(
  db: Database,
  relations: Record<string, RelationConfig>,
  requested: Record<string, number>,
  records: RecordRow[]
): Promise<HydrateResult> {
  if (Object.keys(requested).length === 0 || records.length === 0) return {};

  // Accumulate grouped results first, then flatten ungrouped ones
  const grouped: Record<string, Record<string, Record<string, any[]>>> = {};

  for (const [relName, hydrateLimit] of Object.entries(requested)) {
    const rel = relations[relName];
    const field = getRelationField(rel);
    const matchMode = rel.match ?? "uri";

    const matchValues = matchMode === "did"
      ? [...new Set(records.map((r) => r.did))]
      : records.map((r) => r.uri);

    if (matchValues.length === 0) continue;

    // Fetch more rows than needed since the limit applies per-group, not total
    const groupCount = rel.groupBy ? 10 : 1; // estimate; overfetch is fine
    const maxRows = matchValues.length * hydrateLimit * groupCount;
    const relatedRows = await batchedInQuery<RecordRow>(
      db,
      `SELECT uri, did, collection, rkey, record, time_us FROM records
       WHERE collection = ? AND json_extract(record, '$.${field}') IN (__IN__)
       ORDER BY time_us DESC
       LIMIT ${maxRows}`,
      [rel.collection],
      matchValues
    );

    for (const row of relatedRows) {
      const record = row.record ? JSON.parse(row.record) : null;
      const matchedValue = getNestedValue(record, field);
      if (!matchedValue) continue;

      const parentUris = matchMode === "did"
        ? records.filter((r) => r.did === matchedValue).map((r) => r.uri)
        : [matchedValue];

      const groupValue = rel.groupBy
        ? String(getNestedValue(record, rel.groupBy) ?? "other")
        : "_flat";

      for (const parentUri of parentUris) {
        const targetUri = matchMode === "did" ? parentUri : matchedValue;

        if (!grouped[targetUri]) grouped[targetUri] = {};
        if (!grouped[targetUri][relName]) grouped[targetUri][relName] = {};
        if (!grouped[targetUri][relName][groupValue]) grouped[targetUri][relName][groupValue] = [];

        const group = grouped[targetUri][relName][groupValue];
        if (group.length < hydrateLimit) {
          group.push(formatRecord(row));
        }
      }
    }
  }

  // Convert to final shape: ungrouped relations become flat arrays
  const result: HydrateResult = {};
  for (const [uri, rels] of Object.entries(grouped)) {
    result[uri] = {};
    for (const [relName, groups] of Object.entries(rels)) {
      if (relations[relName].groupBy) {
        result[uri][relName] = groups;
      } else {
        result[uri][relName] = groups["_flat"] ?? [];
      }
    }
  }

  return result;
}
