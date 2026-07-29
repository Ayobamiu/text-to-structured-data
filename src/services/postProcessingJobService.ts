/**
 * Post-processing backfills on the worker ("Run service" in job settings).
 *
 * The endpoint used to call applyServicesToPreview inline over EVERY completed
 * file in the job — 92 files on an average job, 4057 on the largest, each one
 * running geocoding network calls. That held the HTTP request open for the
 * whole backfill and burned an API process the entire time.
 *
 * Shape (mirrors directed re-extraction, `rex:<id>`):
 *   - one `post_processing_requests` row = one operator request (service, slug,
 *     options, apply/force) plus its accumulated summary,
 *   - one `file_processing_queue` item PER FILE, mode `psvc:<requestId>`.
 *
 * Per-file items rather than one big job because the worker runs items one at
 * a time: a single 4000-file item would block every upload behind it for the
 * whole run, while per-file items let normal processing interleave by
 * priority. They also make the run crash-resumable (finished files are
 * already counted) and give the UI real progress.
 *
 * A dry run (`apply: false`) still executes the services — that's where the
 * counts and the geocoding precision distribution come from — it just never
 * writes.
 */

import pool from '../database.js';
import queueService from '../queue.js';
import { getService } from './postProcessing/registry.ts';
import { applyServicesToPreview, type ApplyResult } from './postProcessing/applyToFiles.ts';
import type { RunSummary } from './postProcessing/runner.ts';

const PSVC_MODE_PREFIX = 'psvc:';

export function buildPsvcMode(requestId: string): string {
    return `${PSVC_MODE_PREFIX}${requestId}`;
}

/** @returns the requestId, or null when the mode is not a post-processing mode. */
export function parsePsvcMode(mode: unknown): string | null {
    if (typeof mode !== 'string' || !mode.startsWith(PSVC_MODE_PREFIX)) return null;
    return mode.slice(PSVC_MODE_PREFIX.length) || null;
}

export type PostProcessingRequestRow = {
    id: string;
    job_id: string;
    service: string;
    slug: string;
    options: Record<string, unknown>;
    apply: boolean;
    force: boolean;
    status: 'queued' | 'processing' | 'completed' | 'failed';
    total_files: number;
    processed_files: number;
    summary: ApplyResult | Record<string, never>;
    error: string | null;
    requested_by: string | null;
    created_at: string;
    updated_at: string;
};

export interface PostProcessingProgress {
    phase: 'started' | 'file' | 'done' | 'failed';
    requestId: string;
    jobId: string;
    service: string;
    slug: string;
    apply: boolean;
    processed: number;
    total: number;
    summary?: ApplyResult | null;
    error?: string;
}

/** An empty accumulator with every ApplyResult counter zeroed. */
export function emptyApplyResult(apply: boolean): ApplyResult {
    return {
        apply,
        filesScanned: 0,
        filesUpdated: 0,
        recordsMatched: 0,
        summary: {},
        sideEffects: 0,
        precisionTiers: {},
    };
}

/**
 * Fold one file's ApplyResult into the request-level accumulator. Pure — the
 * caller persists. Counters add; the per-service summary and the geocoding
 * precision tiers merge key-by-key.
 */
export function mergeApplyResults(into: ApplyResult, add: ApplyResult): ApplyResult {
    const out: ApplyResult = {
        apply: into.apply,
        filesScanned: (into.filesScanned || 0) + (add.filesScanned || 0),
        filesUpdated: (into.filesUpdated || 0) + (add.filesUpdated || 0),
        recordsMatched: (into.recordsMatched || 0) + (add.recordsMatched || 0),
        sideEffects: (into.sideEffects || 0) + (add.sideEffects || 0),
        summary: {} as RunSummary,
        precisionTiers: { ...(into.precisionTiers || {}) },
    };
    for (const [name, counts] of Object.entries(into.summary || {})) {
        out.summary[name] = { ...counts };
    }
    for (const [name, counts] of Object.entries(add.summary || {})) {
        const target = out.summary[name] || { applied: 0, skipped: 0, error: 0 };
        for (const [status, n] of Object.entries(counts)) {
            target[status as keyof typeof counts] =
                (target[status as keyof typeof counts] || 0) + (n as number);
        }
        out.summary[name] = target;
    }
    for (const [tier, n] of Object.entries(add.precisionTiers || {})) {
        out.precisionTiers[tier] = (out.precisionTiers[tier] || 0) + n;
    }
    return out;
}

/**
 * Create the request row and enqueue one queue item per completed file in the
 * job. Returns the request plus how many files were queued; a job with no
 * completed files short-circuits to a completed request (nothing to scan).
 */
export async function enqueuePostProcessingRequest({
    jobId,
    service,
    slug,
    options = {},
    apply = false,
    force = false,
    requestedBy = null,
}: {
    jobId: string;
    service: string;
    slug: string;
    options?: Record<string, unknown>;
    apply?: boolean;
    force?: boolean;
    requestedBy?: string | null;
}): Promise<{ request: PostProcessingRequestRow; queued: number }> {
    const filesRes = await pool.query(
        `SELECT id FROM job_files WHERE job_id = $1 AND processing_status = 'completed'`,
        [jobId],
    );
    const fileIds: string[] = filesRes.rows.map((r: { id: string }) => r.id);

    const inserted = await pool.query(
        `INSERT INTO post_processing_requests
            (job_id, service, slug, options, apply, force, requested_by, total_files, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
            jobId, service, slug, JSON.stringify(options), apply, force, requestedBy,
            fileIds.length,
            fileIds.length === 0 ? 'completed' : 'queued',
        ],
    );
    const request: PostProcessingRequestRow = inserted.rows[0];

    if (fileIds.length === 0) {
        console.log(`⏭️ post-processing "${service}" on job ${jobId}: no completed files — nothing queued`);
        return { request, queued: 0 };
    }

    const mode = buildPsvcMode(request.id);
    for (const fileId of fileIds) {
        await queueService.addFileToQueue(fileId, jobId, 0, mode);
    }
    console.log(
        `📥 Queued post-processing "${service}" (${apply ? 'apply' : 'dry-run'}) ` +
        `on ${fileIds.length} file(s) of job ${jobId} — request ${request.id}`,
    );
    return { request, queued: fileIds.length };
}

export async function getPostProcessingRequest(requestId: string): Promise<PostProcessingRequestRow | null> {
    const res = await pool.query(`SELECT * FROM post_processing_requests WHERE id = $1`, [requestId]);
    return res.rows[0] || null;
}

/** Latest request for a job — what the settings page shows on reload. */
export async function getLatestPostProcessingRequest(jobId: string): Promise<PostProcessingRequestRow | null> {
    const res = await pool.query(
        `SELECT * FROM post_processing_requests
         WHERE job_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [jobId],
    );
    return res.rows[0] || null;
}

/**
 * Run one file of a post-processing request: execute the service over that
 * file, fold the result into the request's running summary, and report
 * progress. Terminal per file — a failure marks the whole request failed but
 * leaves the already-counted files intact (re-running is safe: services are
 * idempotent on their own output).
 */
export async function runPostProcessingFile({
    requestId,
    fileId,
    onProgress = null,
}: {
    requestId: string;
    fileId: string;
    onProgress?: ((evt: PostProcessingProgress) => void) | null;
}): Promise<{ status: 'ok' | 'skipped' | 'failed'; request: PostProcessingRequestRow | null }> {
    const progress = (evt: PostProcessingProgress) => {
        try {
            onProgress?.(evt);
        } catch { /* progress must never break the run */ }
    };

    const request = await getPostProcessingRequest(requestId);
    if (!request) {
        console.warn(`⚠️ post-processing request ${requestId} is gone — dropping queue item for file ${fileId}`);
        return { status: 'skipped', request: null };
    }
    if (request.status === 'failed') {
        // An earlier file failed the request; don't keep billing the rest.
        return { status: 'skipped', request };
    }

    const service = getService(request.service);
    if (!service) {
        const message = `Unknown post-processing service "${request.service}"`;
        await failRequest(requestId, message);
        progress({
            phase: 'failed', requestId, jobId: request.job_id, service: request.service,
            slug: request.slug, apply: request.apply, processed: request.processed_files,
            total: request.total_files, error: message,
        });
        return { status: 'failed', request };
    }

    if (request.status === 'queued') {
        await pool.query(
            `UPDATE post_processing_requests SET status = 'processing', updated_at = NOW()
             WHERE id = $1 AND status = 'queued'`,
            [requestId],
        );
        progress({
            phase: 'started', requestId, jobId: request.job_id, service: request.service,
            slug: request.slug, apply: request.apply, processed: request.processed_files,
            total: request.total_files,
        });
    }

    let fileResult: ApplyResult;
    try {
        fileResult = await applyServicesToPreview({
            itemIds: [fileId],
            slug: request.slug,
            services: [service],
            optionsByService: { [request.service]: request.options || {} },
            apply: Boolean(request.apply),
            force: Boolean(request.force),
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await failRequest(requestId, `file ${fileId}: ${message}`);
        progress({
            phase: 'failed', requestId, jobId: request.job_id, service: request.service,
            slug: request.slug, apply: request.apply, processed: request.processed_files,
            total: request.total_files, error: message,
        });
        return { status: 'failed', request };
    }

    // Fold into the request row under a row lock so a scaled-out worker can't
    // lose a file's counts to a concurrent update.
    const client = await pool.connect();
    let updated: PostProcessingRequestRow;
    try {
        await client.query('BEGIN');
        const locked = await client.query(
            `SELECT * FROM post_processing_requests WHERE id = $1 FOR UPDATE`,
            [requestId],
        );
        const current: PostProcessingRequestRow = locked.rows[0];
        const accumulated = mergeApplyResults(
            (current.summary && Object.keys(current.summary).length > 0
                ? current.summary as ApplyResult
                : emptyApplyResult(Boolean(current.apply))),
            fileResult,
        );
        const processed = (current.processed_files || 0) + 1;
        const done = processed >= (current.total_files || 0);
        const res = await client.query(
            `UPDATE post_processing_requests
             SET processed_files = $2,
                 summary = $3,
                 status = CASE WHEN $4 THEN 'completed' ELSE status END,
                 updated_at = NOW()
             WHERE id = $1
             RETURNING *`,
            [requestId, processed, JSON.stringify(accumulated), done],
        );
        updated = res.rows[0];
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK').catch(() => { });
        throw error;
    } finally {
        client.release();
    }

    progress({
        phase: updated.status === 'completed' ? 'done' : 'file',
        requestId,
        jobId: updated.job_id,
        service: updated.service,
        slug: updated.slug,
        apply: updated.apply,
        processed: updated.processed_files,
        total: updated.total_files,
        summary: updated.summary as ApplyResult,
    });

    if (updated.status === 'completed') {
        const s = updated.summary as ApplyResult;
        console.log(
            `✅ Post-processing "${updated.service}" ${updated.apply ? 'applied' : 'dry-run'} ` +
            `on job ${updated.job_id}: ${s.filesScanned} file(s) scanned, ` +
            `${s.recordsMatched} record(s) matched, ${s.filesUpdated} file(s) updated`,
        );
    }
    return { status: 'ok', request: updated };
}

async function failRequest(requestId: string, error: string): Promise<void> {
    await pool.query(
        `UPDATE post_processing_requests
         SET status = 'failed', error = $2, updated_at = NOW()
         WHERE id = $1`,
        [requestId, error],
    );
    console.error(`❌ post-processing request ${requestId} failed: ${error}`);
}

export default {
    buildPsvcMode,
    parsePsvcMode,
    emptyApplyResult,
    mergeApplyResults,
    enqueuePostProcessingRequest,
    getPostProcessingRequest,
    getLatestPostProcessingRequest,
    runPostProcessingFile,
};
