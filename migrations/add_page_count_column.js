#!/usr/bin/env node
/**
 * Database Migration: Add page_count column to job_files table
 * Adds: page_count integer column to store detected page counts for each file
 */

import pg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '..', '.env') });

const { Pool } = pg;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || `postgresql://${process.env.DB_USER || 'postgres'}:${process.env.DB_PASSWORD || 'password'}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 5432}/${process.env.DB_NAME || 'batch_processor'}`,
    family: 4,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

async function addPageCountColumn() {
    const client = await pool.connect();
    try {
        console.log('🔄 Adding page_count column to job_files table...');

        // Check if the page_count column already exists
        const checkQuery = `
            SELECT column_name
            FROM information_schema.columns
            WHERE table_name = 'job_files'
              AND column_name = 'page_count'
        `;
        const checkResult = await client.query(checkQuery);

        if (checkResult.rows.length === 0) {
            await client.query(`
                ALTER TABLE job_files
                ADD COLUMN page_count INTEGER
            `);
            await client.query(`
                COMMENT ON COLUMN job_files.page_count IS 'Number of pages detected for the source document'
            `);
            console.log('✅ Added page_count column');
        } else {
            console.log('✅ page_count column already exists');
        }

        // Backfill page_count for existing records using pages JSON when possible
        const backfillQuery = `
            UPDATE job_files
            SET page_count = CASE
                WHEN pages IS NULL THEN NULL
                WHEN jsonb_typeof(pages) = 'array' THEN jsonb_array_length(pages)
                WHEN jsonb_typeof(pages) = 'number' THEN (pages)::INTEGER
                ELSE page_count
            END
            WHERE page_count IS NULL
              AND pages IS NOT NULL
        `;
        await client.query(backfillQuery);
        console.log('✅ Backfilled page_count values from existing pages data where available');

    } catch (error) {
        console.error('❌ Error adding page_count column:', error.message);
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    addPageCountColumn()
        .then(() => {
            console.log('🎉 Migration completed successfully!');
            process.exit(0);
        })
        .catch((error) => {
            console.error('💥 Migration failed:', error);
            process.exit(1);
        });
}

export { addPageCountColumn };


