/**
 * Backfill: Populate job_file_stats from existing job_files data.
 *
 * Scans every job that has files and inserts a computed stats row.
 * Safe to re-run — uses INSERT ... ON CONFLICT DO UPDATE.
 *
 * Usage: node migrations/backfill_job_file_stats.js
 */
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function backfill() {
    const client = await pool.connect();
    try {
        // Get all distinct job_ids that have files
        const jobsResult = await client.query(`
            SELECT DISTINCT job_id FROM job_files
        `);

        const jobIds = jobsResult.rows.map(r => r.job_id);
        console.log(`📊 Found ${jobIds.length} jobs to backfill stats for`);

        let success = 0;
        let failed = 0;

        for (const jobId of jobIds) {
            try {
                // Compute counts from job_files
                const statsResult = await client.query(`
                    SELECT
                        COUNT(*) as total,
                        COUNT(*) FILTER (WHERE extraction_status = 'pending') as extraction_pending,
                        COUNT(*) FILTER (WHERE extraction_status = 'processing') as extraction_processing,
                        COUNT(*) FILTER (WHERE extraction_status = 'completed') as extraction_completed,
                        COUNT(*) FILTER (WHERE extraction_status = 'failed') as extraction_failed,
                        COUNT(*) FILTER (WHERE processing_status = 'pending') as processing_pending,
                        COUNT(*) FILTER (WHERE processing_status = 'processing') as processing_processing,
                        COUNT(*) FILTER (WHERE processing_status = 'completed') as processing_completed,
                        COUNT(*) FILTER (WHERE processing_status = 'failed') as processing_failed
                    FROM job_files
                    WHERE job_id = $1
                `, [jobId]);

                const row = statsResult.rows[0];

                // Upsert stats row
                await client.query(`
                    INSERT INTO job_file_stats (
                        job_id, total,
                        extraction_pending, extraction_processing, extraction_completed, extraction_failed,
                        processing_pending, processing_processing, processing_completed, processing_failed,
                        updated_at
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
                    ON CONFLICT (job_id) DO UPDATE SET
                        total = EXCLUDED.total,
                        extraction_pending = EXCLUDED.extraction_pending,
                        extraction_processing = EXCLUDED.extraction_processing,
                        extraction_completed = EXCLUDED.extraction_completed,
                        extraction_failed = EXCLUDED.extraction_failed,
                        processing_pending = EXCLUDED.processing_pending,
                        processing_processing = EXCLUDED.processing_processing,
                        processing_completed = EXCLUDED.processing_completed,
                        processing_failed = EXCLUDED.processing_failed,
                        updated_at = NOW()
                `, [
                    jobId,
                    parseInt(row.total, 10),
                    parseInt(row.extraction_pending, 10),
                    parseInt(row.extraction_processing, 10),
                    parseInt(row.extraction_completed, 10),
                    parseInt(row.extraction_failed, 10),
                    parseInt(row.processing_pending, 10),
                    parseInt(row.processing_processing, 10),
                    parseInt(row.processing_completed, 10),
                    parseInt(row.processing_failed, 10)
                ]);

                success++;
                if (success % 50 === 0) {
                    console.log(`  ... backfilled ${success}/${jobIds.length} jobs`);
                }
            } catch (jobError) {
                failed++;
                console.error(`  ❌ Failed job ${jobId}: ${jobError.message}`);
            }
        }

        console.log(`✅ Backfill complete: ${success} succeeded, ${failed} failed out of ${jobIds.length} total`);
    } catch (error) {
        console.error('❌ Backfill failed:', error.message);
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

backfill().then(() => {
    console.log('🎉 Backfill complete');
    process.exit(0);
}).catch(() => {
    process.exit(1);
});
