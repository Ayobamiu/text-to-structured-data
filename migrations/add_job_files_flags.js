/**
 * Migration: Add flags JSONB column to job_files.
 *
 * Stores server-computed constraint flags so the list endpoint can return
 * them directly without sending the full result blob to the client.
 *
 * Usage: node migrations/add_job_files_flags.js
 */
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function migrate() {
    const client = await pool.connect();
    try {
        // Add flags column if it doesn't exist
        await client.query(`
            ALTER TABLE job_files
            ADD COLUMN IF NOT EXISTS flags JSONB NOT NULL DEFAULT '[]'::jsonb
        `);
        console.log('✅ Added flags column to job_files');

        // Create index for querying files with failed flags
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_job_files_flags_length
            ON job_files ((jsonb_array_length(flags)))
            WHERE flags != '[]'::jsonb
        `);
        console.log('✅ Created partial index on flags length');

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
