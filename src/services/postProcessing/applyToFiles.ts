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

/**
 * Persist side effects to their target tables (upsert by primary key so re-runs
 * never duplicate). Currently a no-op seam: no built-in service emits side
 * effects yet — D2's geocoder will, against record_geocodes. Throws on an
 * unknown table so a misconfigured service fails loudly rather than silently.
 */
async function persistSideEffects(_client: unknown, sideEffects: SideEffect[]): Promise<void> {
    if (!sideEffects || sideEffects.length === 0) return;
    const tables = new Set(sideEffects.map((s) => s.table));
    throw new Error(
        `persistSideEffects: no handler registered for table(s) [${[...tables].join(', ')}] ` +
        `(wired in D2 with record_geocodes)`,
    );
}

export default { applyServicesToPreview, mergeUpdatedRecordsIntoResult };
