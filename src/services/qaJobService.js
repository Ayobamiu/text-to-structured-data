/**
 * QA job service — section QA as a background worker job.
 *
 * QA jobs ride the existing Postgres queue (file_processing_queue) using a
 * mode string instead of a new column (no migration needed):
 *
 *   qa:all                        QA every section in the file
 *   qa:remaining                  QA only sections without a persisted run
 *   qa:section:<sectionResultId>  QA one section
 *
 * An optional "@<model>" suffix carries a per-run model override for A/B
 * testing, e.g. "qa:all@gpt-4.1".
 *
 * The worker detects these modes via parseQAMode() and calls runFileQAJob()
 * instead of the extraction pipeline. Progress is reported through the
 * onProgress callback; the worker forwards each event over Socket.IO as
 * `qa-progress-event` (relayed by the server to the job room).
 */

import pool from '../database.js';
import { getFileResult } from '../database.js';
import S3Service from '../s3Service.js';

const QA_MODE_PREFIX = 'qa:';

export function buildQAMode({ scope = 'all', sectionResultId = null, model = null } = {}) {
    let mode;
    if (scope === 'section') {
        if (!sectionResultId) throw new Error('sectionResultId required for section-scoped QA');
        mode = `${QA_MODE_PREFIX}section:${sectionResultId}`;
    } else if (scope === 'remaining') {
        mode = `${QA_MODE_PREFIX}remaining`;
    } else {
        mode = `${QA_MODE_PREFIX}all`;
    }
    return model ? `${mode}@${model}` : mode;
}

/**
 * @param {string} mode  queue mode string
 * @returns {{ scope: 'all'|'remaining'|'section', sectionResultId: string|null, model: string|null }|null}
 *          null when the mode is not a QA mode.
 */
export function parseQAMode(mode) {
    if (typeof mode !== 'string' || !mode.startsWith(QA_MODE_PREFIX)) return null;
    let rest = mode.slice(QA_MODE_PREFIX.length);
    let model = null;
    const at = rest.indexOf('@');
    if (at >= 0) {
        model = rest.slice(at + 1) || null;
        rest = rest.slice(0, at);
    }
    if (rest === 'all' || rest === 'remaining') {
        return { scope: rest, sectionResultId: null, model };
    }
    if (rest.startsWith('section:')) {
        const sectionResultId = rest.slice('section:'.length);
        if (!sectionResultId) return null;
        return { scope: 'section', sectionResultId, model };
    }
    return null;
}

/**
 * QA jobs currently queued or running for a file. Used by the enqueue
 * endpoints for dedupe and by GET /files/:id/qa-findings so a reloaded
 * client can restore its "QA running" indicators.
 *
 * @returns {Promise<Array<{ scope, sectionResultId, model, status }>>}
 */
export async function getActiveQAJobs(fileId) {
    // Respect QUEUE_SHARD like queue.js does — a dev-queued QA job must not
    // block (or show up for) another shard sharing the same database.
    const shard = process.env.QUEUE_SHARD || null;
    const res = await pool.query(
        `SELECT mode, status FROM file_processing_queue
         WHERE file_id = $1 AND mode LIKE 'qa:%' AND status IN ('queued', 'processing')
         ${shard ? 'AND queue_shard = $2' : ''}`,
        shard ? [fileId, shard] : [fileId]
    );
    return res.rows
        .map((row) => {
            const parsed = parseQAMode(row.mode);
            return parsed ? { ...parsed, status: row.status } : null;
        })
        .filter(Boolean);
}

/**
 * Collect the V2 records eligible for QA in a file, honoring scope.
 * Shared between the enqueue-time validation (server) and the worker run.
 *
 * @returns {Promise<{ file, records: Array<{ slug, record, sectionResultId, pageNumbers }> }>}
 * @throws when the file/scope is not QA-able (message is user-facing)
 */
export async function collectQARecords({ fileId, scope, sectionResultId }) {
    const file = await getFileResult(fileId);
    if (!file) throw new Error('File not found');
    if (!file.result || typeof file.result !== 'object') {
        throw new Error('File has no extraction result');
    }
    if (!file.s3_key) {
        throw new Error('File has no S3 key — QA requires S3 storage');
    }

    const detected = file.detected_sections?.sections || [];
    const pagesFor = (sid) =>
        detected.find((s) => s.section_result_id === sid)?.extraction_pages || [];

    let records = [];
    for (const [slug, arr] of Object.entries(file.result)) {
        if (!Array.isArray(arr)) continue;
        for (const rec of arr) {
            if (rec?.section_result_id) {
                records.push({
                    slug,
                    record: rec,
                    sectionResultId: rec.section_result_id,
                    pageNumbers: pagesFor(rec.section_result_id),
                });
            }
        }
    }
    if (!records.length) {
        throw new Error('No V2 records found — is this a V2 file?');
    }

    if (scope === 'section') {
        records = records.filter((r) => r.sectionResultId === sectionResultId);
        if (!records.length) {
            throw new Error(`No record with section_result_id '${sectionResultId}'`);
        }
        if (!records[0].pageNumbers.length) {
            throw new Error('No extraction pages found for this section');
        }
    } else if (scope === 'remaining') {
        const { getQARuns } = await import('./sectionQAService.js');
        const runs = await getQARuns(fileId);
        records = records.filter((r) => !runs[r.sectionResultId]);
    }

    return { file, records };
}

/**
 * Run a QA job end-to-end (worker side). Never throws for per-section
 * failures — those are reported via onProgress and the summary. Throws only
 * for fatal setup errors (file missing, no records, S3 download failure).
 *
 * onProgress receives:
 *   { status: 'started',        sectionResultIds, progress }
 *   { status: 'section_start',  sectionResultId, slug, progress }
 *   { status: 'section_done',   sectionResultId, slug, progress, findingsCount, overallQuality, findings }
 *   { status: 'section_failed', sectionResultId, slug, progress, message }
 *   { status: 'done',           progress, totalSections, totalFindings, failedSections }
 *
 * @returns {Promise<{ totalSections: number, totalFindings: number, failedSections: number }>}
 */
export async function runFileQAJob({ fileId, scope, sectionResultId = null, model = null, onProgress = null }) {
    const emit = (evt) => {
        try {
            onProgress?.(evt);
        } catch (err) {
            console.warn(`⚠️ QA progress callback failed: ${err.message}`);
        }
    };

    const { file, records } = await collectQARecords({ fileId, scope, sectionResultId });

    if (!records.length) {
        // scope=remaining with everything already QA'd — a no-op success.
        emit({ status: 'done', progress: { current: 0, total: 0 }, totalSections: 0, totalFindings: 0, failedSections: 0 });
        return { totalSections: 0, totalFindings: 0, failedSections: 0 };
    }

    const { runSectionQA, saveQAFindings } = await import('./sectionQAService.js');

    const s3 = new S3Service();
    const pdfBuffer = await s3.downloadFile(file.s3_key);

    const total = records.length;
    emit({
        status: 'started',
        sectionResultIds: records.map((r) => r.sectionResultId),
        progress: { current: 0, total },
    });

    console.log(`🔍 QA job: ${total} section(s) of ${file.filename} (scope=${scope})`);

    let totalFindings = 0;
    let failedSections = 0;
    let current = 0;

    for (const { slug, record, sectionResultId: sid, pageNumbers } of records) {
        current += 1;
        const progress = { current, total };

        if (!pageNumbers.length) {
            failedSections += 1;
            emit({ status: 'section_failed', sectionResultId: sid, slug, progress, message: 'No extraction pages for this section' });
            continue;
        }

        emit({ status: 'section_start', sectionResultId: sid, slug, progress: { current: current - 1, total } });

        try {
            const qaResult = await runSectionQA({
                fileId,
                sectionResultId: sid,
                slug,
                pageNumbers,
                extractionRecord: record,
                pdfBuffer,
                ...(model ? { model } : {}),
            });

            const savedFindings = await saveQAFindings({
                fileId,
                sectionResultId: sid,
                findings: qaResult.findings,
                overall_quality: qaResult.overall_quality,
                summary: qaResult.summary,
                qaModel: qaResult.model,
                tokens: qaResult.tokens || null,
            });

            totalFindings += savedFindings.length;
            emit({
                status: 'section_done',
                sectionResultId: sid,
                slug,
                progress,
                findingsCount: savedFindings.length,
                overallQuality: qaResult.overall_quality,
                findings: savedFindings,
            });
        } catch (err) {
            failedSections += 1;
            console.warn(`⚠️ QA failed for section ${sid.substring(0, 8)}...: ${err.message}`);
            emit({ status: 'section_failed', sectionResultId: sid, slug, progress, message: err.message });
        }
    }

    console.log(`✅ QA job complete for ${file.filename}: ${totalFindings} finding(s) across ${total} section(s), ${failedSections} failed`);

    emit({
        status: 'done',
        progress: { current: total, total },
        totalSections: total,
        totalFindings,
        failedSections,
    });

    return { totalSections: total, totalFindings, failedSections };
}

export default { buildQAMode, parseQAMode, getActiveQAJobs, collectQARecords, runFileQAJob };
