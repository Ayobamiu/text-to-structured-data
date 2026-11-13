/**
 * ensureProjected — on-demand projection for the query layer.
 *
 * Before querying a scope, make sure its files have rows in extracted_records for
 * the slug. Files already projected are skipped; missing ones are projected on the
 * spot by running the projectRecords post-processing service (same projector used
 * during post-processing — no new code path). This is what makes the FIRST query
 * on an unprojected file work; subsequent queries hit the existing rows.
 */

import pool from '../../database.js';
import { applyServicesToPreview } from '../../services/postProcessing/applyToFiles.ts';
import projectRecords from '../../services/postProcessing/services/projectRecords.ts';

interface Queryable {
    query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
}

export interface EnsureArgs {
    fileIds: string[];
    slug: string;
    deps?: { db?: Queryable };
}

export interface EnsureResult {
    alreadyProjected: number;
    projectedNow: number;
    recordsMatched: number;
    rowsWritten: number;
    /** Wall-clock ms spent projecting (0 if nothing needed projecting). */
    ms: number;
}

export async function ensureProjected({ fileIds, slug, deps = {} }: EnsureArgs): Promise<EnsureResult> {
    const db = deps.db ?? (pool as unknown as Queryable);
    if (!fileIds || fileIds.length === 0) {
        return { alreadyProjected: 0, projectedNow: 0, recordsMatched: 0, rowsWritten: 0, ms: 0 };
    }

    const existing = await db.query(
        `SELECT DISTINCT file_id::text AS file_id FROM extracted_records WHERE slug = $1 AND file_id = ANY($2)`,
        [slug, fileIds],
    );
    const have = new Set(existing.rows.map((r) => String(r.file_id)));
    const missing = fileIds.filter((id) => !have.has(id));

    if (missing.length === 0) {
        return { alreadyProjected: fileIds.length, projectedNow: 0, recordsMatched: 0, rowsWritten: 0, ms: 0 };
    }

    const t0 = Date.now();
    const res = await applyServicesToPreview({
        itemIds: missing,
        slug,
        services: [projectRecords],
        apply: true,
    });
    const ms = Date.now() - t0;

    return {
        alreadyProjected: have.size,
        projectedNow: missing.length,
        recordsMatched: res.recordsMatched,
        rowsWritten: res.sideEffects,
        ms,
    };
}

export default ensureProjected;
