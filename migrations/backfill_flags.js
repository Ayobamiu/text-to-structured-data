/**
 * Backfill: Recompute flags for all completed job_files.
 *
 * Run AFTER add_job_files_flags.js migration adds the flags column.
 *
 * Usage: node migrations/backfill_flags.js
 */
import dotenv from 'dotenv';
import pg from 'pg';
import { computeFlags } from '../src/services/constraintsService.js';

dotenv.config();

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const BATCH_SIZE = 100;

async function backfill() {
    const client = await pool.connect();
    try {
        // Count total files to backfill
        const countResult = await client.query(`
            SELECT COUNT(*) as total
            FROM job_files
            WHERE processing_status = 'completed' AND result IS NOT NULL
        `);
        const total = parseInt(countResult.rows[0].total);
        console.log(`📊 Total files to backfill: ${total}`);

        let processed = 0;
        let updated = 0;
        let offset = 0;

        while (offset < total) {
            const batch = await client.query(`
                SELECT id, job_id, filename, processing_status, result, processing_metadata
                FROM job_files
                WHERE processing_status = 'completed' AND result IS NOT NULL
                ORDER BY created_at ASC
                LIMIT $1 OFFSET $2
            `, [BATCH_SIZE, offset]);

            for (const row of batch.rows) {
                let result = row.result;
                if (typeof result === 'string') {
                    try { result = JSON.parse(result); } catch { result = null; }
                }

                let processingMetadata = row.processing_metadata;
                if (typeof processingMetadata === 'string') {
                    try { processingMetadata = JSON.parse(processingMetadata); } catch { processingMetadata = null; }
                }

                const flags = computeFlags({
                    jobId: row.job_id,
                    filename: row.filename,
                    processingStatus: row.processing_status,
                    result,
                    processingMetadata,
                });

                if (flags.length > 0) {
                    await client.query(
                        `UPDATE job_files SET flags = $1, updated_at = NOW() WHERE id = $2`,
                        [JSON.stringify(flags), row.id]
                    );
                    updated++;
                }

                processed++;
            }

            offset += BATCH_SIZE;
            console.log(`  ⏳ Processed ${processed}/${total} (${updated} updated with flags)`);
        }

        console.log(`✅ Backfill complete: ${processed} files processed, ${updated} updated`);
    } catch (error) {
        console.error('❌ Backfill failed:', error.message);
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

backfill().then(() => {
    console.log('🎉 Backfill done');
    process.exit(0);
}).catch(() => {
    process.exit(1);
});
