/**
 * Apply post-processing services across a preview's files.
 *
 * Per file: flatten the V1/V2 result, select the records of the target slug, run
 * the services, and (when apply=true) merge the updated records back into the
 * file's envelope and persist + upsert any side effects — all in one transaction.
 *
 * dry-run (apply=false): services still run (so we get real counts and, for
 * geocoding, the precision distribution), but nothing is written.
 */

import pool from '../../database.js';
// resultEnvelope is still JavaScript.
import { flattenRecords, mapRecords, inferSlugFromShape } from '../../utils/resultEnvelope.js';
import { runServices, type RunSummary } from './runner.ts';
import type { PostProcessingService, RecordObject, SideEffect } from './types.ts';

/** Effective slug of a record: its envelope slug, else shape-inferred (V1). */
function effSlug(slug: string | null, record: RecordObject): string | null {
    return slug || inferSlugFromShape(record) || null;
}

/** Does a record's effective slug match the requested slug filter? */
function matchesSlug(requested: string, recSlug: string | null): boolean {
    if (requested === 'untyped') return recSlug === null;
    return recSlug === requested;
}

/**
 * Merge updated records back into a result envelope without mutating the input.
 * V2 records are matched by section_result_id; a V1 (single-record) result is
 * replaced by `updatedV1` when provided. Pure — unit-testable without a DB.
 */
export function mergeUpdatedRecordsIntoResult(
    result: unknown,
    updatedById: Map<string, RecordObject>,
    updatedV1?: RecordObject,
): { result: unknown; updatedCount: number } {
    let updatedCount = 0;
    // resultEnvelope is untyped JS; the envelope is dynamic JSON.
    // mapRecords (untyped JS) hands us each record as a broad object; treat as RecordObject.
    const newResult = mapRecords(result as object, (raw: object): object => {
        const record = raw as RecordObject;
        const id = record && record.section_result_id;
        if (id) {
            const updated = updatedById.get(id);
            if (updated) {
                updatedCount++;
                return updated;
            }
        }
        if (!id && updatedV1) {
            updatedCount++;
            return updatedV1;
        }
        return record;
    });
    return { result: newResult, updatedCount };
}

export interface ApplyArgs {
    itemIds: string[];
    slug: string;
    services: PostProcessingService[];
    optionsByService?: Record<string, Record<string, unknown>>;
    apply?: boolean;
    force?: boolean;
}

export interface ApplyResult {
    apply: boolean;
    filesScanned: number;
    filesUpdated: number;
    recordsMatched: number;
    summary: RunSummary;
    sideEffects: number;
    /** record_geocodes precision-tier distribution (for the geocoding dry-run report). */
    precisionTiers: Record<string, number>;
}

/** Merge two run summaries (accumulate counts per service/status). */
function mergeSummary(into: RunSummary, add: RunSummary): void {
    for (const [name, counts] of Object.entries(add)) {
        into[name] = into[name] || { applied: 0, skipped: 0, error: 0 };
        for (const [status, n] of Object.entries(counts)) {
            into[name][status as keyof typeof counts] += n;
        }
    }
}

export async function applyServicesToPreview({
    itemIds,
    slug,
    services,
    optionsByService = {},
    apply = false,
    force = false,
}: ApplyArgs): Promise<ApplyResult> {
    const out: ApplyResult = {
        apply,
        filesScanned: 0,
        filesUpdated: 0,
        recordsMatched: 0,
        summary: {},
        sideEffects: 0,
        precisionTiers: {},
    };
    if (!itemIds || itemIds.length === 0) return out;

    const client = await pool.connect();
    try {
        const filesRes = await client.query(
            `SELECT jf.id, jf.result FROM job_files jf
             WHERE jf.id = ANY($1) AND jf.result IS NOT NULL AND jsonb_typeof(jf.result) = 'object'`,
            [itemIds],
        );
        out.filesScanned = filesRes.rows.length;

        for (const file of filesRes.rows) {
            const fileId: string = file.id;
            // resultEnvelope is untyped JS — annotate the shape we rely on.
            const { isV2, records } = flattenRecords(file.result) as {
                isV2: boolean;
                records: Array<{ slug: string | null; index: number; record: RecordObject }>;
            };

            // Select only records of the requested slug.
            const targetRecords: RecordObject[] = records
                .filter((r) => matchesSlug(slug, effSlug(r.slug, r.record)))
                .map((r) => r.record);

            if (targetRecords.length === 0) continue;
            out.recordsMatched += targetRecords.length;

            const run = await runServices({
                records: targetRecords,
                services,
                slugOf: () => (slug === 'untyped' ? null : slug),
                fileId,
                optionsByService,
                force,
            });
            mergeSummary(out.summary, run.summary);
            out.sideEffects += run.sideEffects.length;
            for (const se of run.sideEffects) {
                if (se.table === 'record_geocodes') {
                    const tier = String((se.row as Record<string, unknown>).precision_tier ?? 'unknown');
                    out.precisionTiers[tier] = (out.precisionTiers[tier] || 0) + 1;
                }
            }

            if (!apply) continue;

            // Build the id→updated map and persist the merged envelope.
            const updatedById = new Map<string, RecordObject>();
            let updatedV1: RecordObject | undefined;
            for (const rec of run.records) {
                if (rec.section_result_id) updatedById.set(rec.section_result_id, rec);
                else if (!isV2) updatedV1 = rec;
            }

            const { result: newResult, updatedCount } = mergeUpdatedRecordsIntoResult(
                file.result,
                updatedById,
                updatedV1,
            );

            await client.query('BEGIN');
            try {
                if (updatedCount > 0) {
                    await client.query(
                        `UPDATE job_files SET result = $1, updated_at = NOW() WHERE id = $2`,
                        [JSON.stringify(newResult), fileId],
                    );
                    out.filesUpdated++;
                }
                await persistSideEffects(client, run.sideEffects);
                await client.query('COMMIT');
            } catch (e) {
                await client.query('ROLLBACK');
                throw e;
            }
        }

        return out;
    } finally {
        client.release();
    }
}

/** A pg client (or pool) — only query() is used here. */
interface Queryable {
    query: (text: string, params?: unknown[]) => Promise<unknown>;
}

const RECORD_GEOCODE_COLS = [
    'section_result_id', 'file_id', 'slug', 'latitude', 'longitude',
    'precision_tier', 'strategy', 'provider', 'provider_location_type',
    'source_query', 'confidence', 'needs_review', 'raw_response', 'geocoder_version',
];

/**
 * Persist collected side effects, upserting by primary key so re-runs never
 * duplicate. Handles the tables the built-in services emit; throws on an unknown
 * table so a misconfigured service fails loudly.
 */
async function persistSideEffects(client: Queryable, sideEffects: SideEffect[]): Promise<void> {
    if (!sideEffects || sideEffects.length === 0) return;
    for (const se of sideEffects) {
        if (se.table === 'record_geocodes') {
            const row = se.row as Record<string, unknown>;
            const vals = RECORD_GEOCODE_COLS.map((c) =>
                c === 'raw_response' && row[c] !== undefined && row[c] !== null
                    ? JSON.stringify(row[c]) : (row[c] ?? null));
            const placeholders = RECORD_GEOCODE_COLS.map((_, i) => `$${i + 1}`).join(', ');
            const updates = RECORD_GEOCODE_COLS.filter((c) => c !== 'section_result_id')
                .map((c) => `${c} = EXCLUDED.${c}`).join(', ');
            await client.query(
                `INSERT INTO record_geocodes (${RECORD_GEOCODE_COLS.join(', ')})
                 VALUES (${placeholders})
                 ON CONFLICT (section_result_id) DO UPDATE SET ${updates}, geocoded_at = NOW()`,
                vals,
            );
        } else if (se.table === 'plss_section_centroids') {
            const r = se.row as Record<string, unknown>;
            await client.query(
                `INSERT INTO plss_section_centroids (town, range, section, latitude, longitude, n_wells, source)
                 VALUES ($1,$2,$3,$4,$5,$6,$7)
                 ON CONFLICT (town, range, section) DO UPDATE SET
                   latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude,
                   n_wells = EXCLUDED.n_wells, source = EXCLUDED.source, computed_at = NOW()`,
                [r.town, r.range, r.section, r.latitude ?? null, r.longitude ?? null, r.n_wells ?? null, r.source ?? 'wellogic'],
            );
        } else {
            throw new Error(`persistSideEffects: no handler for table "${se.table}"`);
        }
    }
}

export default { applyServicesToPreview, mergeUpdatedRecordsIntoResult };
