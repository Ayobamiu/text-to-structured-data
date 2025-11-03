/**
 * Database Migration: Add raw_data column to job_files table
 * This column will store the raw response from PaddleOCR before conversion
 */

import pg from 'pg';
import dotenv from 'dotenv';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '..', '.env') });

const { Pool } = pg;

async function addRawDataColumn() {
    const pool = new Pool({
        connectionString: process.env.DATABASE_URL || `postgresql://${process.env.DB_USER || 'postgres'}:${process.env.DB_PASSWORD || 'password'}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || '5432'}/${process.env.DB_NAME || 'batch_processor'}`,
        ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
    });

    const client = await pool.connect();

    try {
        console.log('🔄 Adding raw_data column to job_files table...');

        // Check if column already exists
        const checkQuery = `
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name = 'job_files' AND column_name = 'raw_data'
        `;
        const checkResult = await client.query(checkQuery);

        if (checkResult.rows.length > 0) {
            console.log('✅ raw_data column already exists in job_files table');
            return;
        }

        // Add raw_data column as JSONB
        await client.query(`
            ALTER TABLE job_files 
            ADD COLUMN raw_data JSONB
        `);

        // Add comment
        await client.query(`
            COMMENT ON COLUMN job_files.raw_data IS 'Raw extraction response data from PaddleOCR before conversion to standard format'
        `);

        console.log('✅ Successfully added raw_data column to job_files table');
    } catch (error) {
        console.error('❌ Error adding raw_data column:', error.message);
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

// Run migration if called directly
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('add_raw_data_column.js')) {
    addRawDataColumn()
        .then(() => {
            console.log('✅ Migration completed successfully');
            process.exit(0);
        })
        .catch((error) => {
            console.error('❌ Migration failed:', error);
            process.exit(1);
        });
}

export { addRawDataColumn };

