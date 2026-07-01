/**
 * Job file stats — O(1) counter maintenance.
 *
 * Every status write calls `adjustStats()` in the same transaction.
 * The summary endpoint reads a single row instead of COUNT(*).
 */
import pg from 'pg';
import dotenv from 'dotenv';
import { getDatabaseUrl } from '../utils/pgConnection.js';

dotenv.config();

const { Pool } = pg;
const pool = new Pool({ connectionString: getDatabaseUrl() });

/**
 * Ensure a stats row exists for the given job. Inserts with zeros if missing.
 * Call this when a file is first added to a job.
 */
export async function ensureStatsRow(client, jobId) {
    await client.query(`
        INSERT INTO job_file_stats (job_id)
        VALUES ($1)
        ON CONFLICT (job_id) DO NOTHING
    `, [jobId]);
}

/**
 * Increment total and set initial extraction_pending when a file is added.
 */
export async function incrementTotal(client, jobId, count = 1) {
    await ensureStatsRow(client, jobId);
    await client.query(`
        UPDATE job_file_stats
        SET total = total + $2,
            extraction_pending = extraction_pending + $2,
            processing_pending = processing_pending + $2,
            updated_at = NOW()
        WHERE job_id = $1
    `, [jobId, count]);
}

/**
 * Decrement total when a file is deleted.
 * Also decrements the current status counters.
 */
export async function decrementTotal(client, jobId, extractionStatus, processingStatus) {
    const validStatuses = ['pending', 'processing', 'completed', 'failed'];
    if (!validStatuses.includes(extractionStatus) || !validStatuses.includes(processingStatus)) return;

    await client.query(`
        UPDATE job_file_stats
        SET total = GREATEST(total - 1, 0),
            extraction_${extractionStatus} = GREATEST(extraction_${extractionStatus} - 1, 0),
            processing_${processingStatus} = GREATEST(processing_${processingStatus} - 1, 0),
            updated_at = NOW()
        WHERE job_id = $1
    `, [jobId]);
}

/**
 * Adjust counters when extraction_status changes.
 * Decrements the old status counter and increments the new one.
 */
export async function adjustExtractionStatus(client, jobId, fromStatus, toStatus) {
    if (fromStatus === toStatus) return;
    const validStatuses = ['pending', 'processing', 'completed', 'failed'];
    if (!validStatuses.includes(fromStatus) || !validStatuses.includes(toStatus)) return;

    await client.query(`
        UPDATE job_file_stats
        SET extraction_${fromStatus} = GREATEST(extraction_${fromStatus} - 1, 0),
            extraction_${toStatus} = extraction_${toStatus} + 1,
            updated_at = NOW()
        WHERE job_id = $1
    `, [jobId]);
}

/**
 * Adjust counters when processing_status changes.
 * Decrements the old status counter and increments the new one.
 */
export async function adjustProcessingStatus(client, jobId, fromStatus, toStatus) {
    if (fromStatus === toStatus) return;
    const validStatuses = ['pending', 'processing', 'completed', 'failed'];
    if (!validStatuses.includes(fromStatus) || !validStatuses.includes(toStatus)) return;

    await client.query(`
        UPDATE job_file_stats
        SET processing_${fromStatus} = GREATEST(processing_${fromStatus} - 1, 0),
            processing_${toStatus} = processing_${toStatus} + 1,
            updated_at = NOW()
        WHERE job_id = $1
    `, [jobId]);
}

/**
 * Get stats for a job — single row select, O(1).
 */
export async function getStats(jobId) {
    const client = await pool.connect();
    try {
        const result = await client.query(
            `SELECT * FROM job_file_stats WHERE job_id = $1`,
            [jobId]
        );
        if (result.rows.length === 0) {
            return {
                total: 0,
                extraction_pending: 0,
                extraction_processing: 0,
                extraction_completed: 0,
                extraction_failed: 0,
                processing_pending: 0,
                processing_processing: 0,
                processing_completed: 0,
                processing_failed: 0,
            };
        }
        const row = result.rows[0];
        return {
            total: row.total,
            extraction_pending: row.extraction_pending,
            extraction_processing: row.extraction_processing,
            extraction_completed: row.extraction_completed,
            extraction_failed: row.extraction_failed,
            processing_pending: row.processing_pending,
            processing_processing: row.processing_processing,
            processing_completed: row.processing_completed,
            processing_failed: row.processing_failed,
        };
    } finally {
        client.release();
    }
}

export default {
    ensureStatsRow,
    incrementTotal,
    decrementTotal,
    adjustExtractionStatus,
    adjustProcessingStatus,
    getStats,
};
