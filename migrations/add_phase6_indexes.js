/**
 * Migration: Add indexes for Phase 6 server-side search, filter & sort.
 *
 * - pg_trgm extension for fuzzy filename search
 * - Trigram GIN index on filename for ILIKE performance
 * - Compound index on (job_id, created_at DESC) for sorted pagination within a job
 *
 * Usage: node migrations/add_phase6_indexes.js
 */
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function migrate() {
    const client = await pool.connect();
    try {
        // Enable trigram extension for ILIKE performance
        await client.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
        console.log('✅ pg_trgm extension enabled');

        // Trigram index for filename search
        await client.query(`
            CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_job_files_filename_trgm
            ON job_files USING gin (filename gin_trgm_ops)
        `);
        console.log('✅ Created filename trigram index');

        // Compound index for sorted pagination within a job
        await client.query(`
            CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_job_files_job_created
            ON job_files (job_id, created_at DESC)
        `);
        console.log('✅ Created job_id + created_at compound index');

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
