/**
 * Migration: Create job_file_stats table for O(1) summary queries.
 *
 * Maintains per-job counters updated transactionally with every status write,
 * eliminating COUNT(*) over the full job_files table.
 *
 * Usage: node migrations/add_job_file_stats.js
 */
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function migrate() {
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS job_file_stats (
                job_id UUID PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
                total INT NOT NULL DEFAULT 0,
                extraction_pending INT NOT NULL DEFAULT 0,
                extraction_processing INT NOT NULL DEFAULT 0,
                extraction_completed INT NOT NULL DEFAULT 0,
                extraction_failed INT NOT NULL DEFAULT 0,
                processing_pending INT NOT NULL DEFAULT 0,
                processing_processing INT NOT NULL DEFAULT 0,
                processing_completed INT NOT NULL DEFAULT 0,
                processing_failed INT NOT NULL DEFAULT 0,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);
        console.log('✅ Created job_file_stats table');

    } catch (error) {
        console.error('❌ Migration failed:', error.message);
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

migrate().then(() => {
    console.log('🎉 Migration complete');
    process.exit(0);
}).catch(() => {
    process.exit(1);
});
