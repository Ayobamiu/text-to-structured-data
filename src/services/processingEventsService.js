/**
 * Processing Events Service
 *
 * Persists the curated, frontend-facing processing timeline (file_processing_events)
 * and shapes rows for the API/socket. The worker calls recordProcessingEvent for
 * every meaningful step; the server reads them back for hydration.
 *
 * These are NOT raw logs — callers pass safe, structured fields only.
 */

import pool from '../database.js';

const VALID_PHASES = new Set([
    'queued', 'classifying', 'extracting', 'ai_extraction',
    'post_processing', 'done', 'failed', 'skipped',
]);

/**
 * Persist one processing event.
 *
 * @param {object} p
 * @param {string} p.fileId
 * @param {string|null} [p.jobId]
 * @param {string} p.phase     one of VALID_PHASES
 * @param {string|null} [p.step]
 * @param {string} [p.status]  active | done | failed | info
 * @param {{current:number,total:number}|null} [p.progress]
 * @param {string|null} [p.message]
 * @param {string} [p.level]   info | warning | error
 * @param {object|null} [p.data]
 * @returns {Promise<object|null>} the stored row (or null on failure — never throws)
 */
export async function recordProcessingEvent({
    fileId, jobId = null, phase, step = null, status = 'info',
    progress = null, message = null, level = 'info', data = null,
}) {
    if (!fileId || !phase) return null;
    const safePhase = VALID_PHASES.has(phase) ? phase : 'info';
    try {
        const res = await pool.query(
            `INSERT INTO file_processing_events
                (file_id, job_id, phase, step, status, progress_current, progress_total, message, level, data)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             RETURNING id, seq, file_id, job_id, phase, step, status,
                       progress_current, progress_total, message, level, data, created_at`,
            [
                fileId, jobId, safePhase, step, status,
                progress?.current ?? null, progress?.total ?? null,
                message, level, data ? JSON.stringify(data) : null,
            ]
        );
        return res.rows[0] || null;
    } catch (err) {
        // Telemetry must never break the pipeline.
        console.warn(`⚠️ recordProcessingEvent failed (${phase}): ${err.message}`);
        return null;
    }
}

/**
 * Read a file's processing timeline in order.
 * @param {string} fileId
 * @param {{limit?:number}} [opts]
 */
export async function getProcessingEvents(fileId, { limit = 1000 } = {}) {
    const res = await pool.query(
        `SELECT id, seq, file_id, job_id, phase, step, status,
                progress_current, progress_total, message, level, data, created_at
         FROM file_processing_events
         WHERE file_id = $1
         ORDER BY seq ASC
         LIMIT $2`,
        [fileId, limit]
    );
    return res.rows;
}

export default { recordProcessingEvent, getProcessingEvents };
