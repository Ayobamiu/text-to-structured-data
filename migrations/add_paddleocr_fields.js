#!/usr/bin/env node
/**
 * Database Migration: Add PaddleOCR-related columns to job_files table
 * Adds: pages, extraction_time_seconds, openai_feed_blocked, openai_feed_unblocked, extraction_metadata
 * Run this script to add the new fields to existing databases
 */

import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || `postgresql://${process.env.DB_USER || 'postgres'}:${process.env.DB_PASSWORD || 'password'}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 5432}/${process.env.DB_NAME || 'batch_processor'}`,
    family: 4,
});

async function addPaddleOCRFields() {
    const client = await pool.connect();
    try {
        console.log('🔄 Adding PaddleOCR-related columns to job_files table...');

        // Check which columns already exist
        const checkQuery = `
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name = 'job_files' 
            AND column_name IN ('pages', 'extraction_time_seconds', 'openai_feed_blocked', 'openai_feed_unblocked', 'extraction_metadata')
        `;
        const checkResult = await client.query(checkQuery);
        const existingColumns = checkResult.rows.map(row => row.column_name);

        // Add pages column if it doesn't exist
        if (!existingColumns.includes('pages')) {
            await client.query(`
                ALTER TABLE job_files 
                ADD COLUMN pages JSONB
            `);
            console.log('✅ Added pages column');
        } else {
            console.log('✅ pages column already exists');
        }

        // Add extraction_time_seconds column if it doesn't exist
        if (!existingColumns.includes('extraction_time_seconds')) {
            await client.query(`
                ALTER TABLE job_files 
                ADD COLUMN extraction_time_seconds NUMERIC
            `);
            console.log('✅ Added extraction_time_seconds column');
        } else {
            console.log('✅ extraction_time_seconds column already exists');
        }

        // Add openai_feed_blocked column if it doesn't exist
        if (!existingColumns.includes('openai_feed_blocked')) {
            await client.query(`
                ALTER TABLE job_files 
                ADD COLUMN openai_feed_blocked TEXT
            `);
            console.log('✅ Added openai_feed_blocked column');
        } else {
            console.log('✅ openai_feed_blocked column already exists');
        }

        // Add openai_feed_unblocked column if it doesn't exist
        if (!existingColumns.includes('openai_feed_unblocked')) {
            await client.query(`
                ALTER TABLE job_files 
                ADD COLUMN openai_feed_unblocked TEXT
            `);
            console.log('✅ Added openai_feed_unblocked column');
        } else {
            console.log('✅ openai_feed_unblocked column already exists');
        }

        // Add extraction_metadata column if it doesn't exist
        if (!existingColumns.includes('extraction_metadata')) {
            await client.query(`
                ALTER TABLE job_files 
                ADD COLUMN extraction_metadata JSONB
            `);
            console.log('✅ Added extraction_metadata column');
        } else {
            console.log('✅ extraction_metadata column already exists');
        }

        // Add comments to columns
        await client.query(`
            COMMENT ON COLUMN job_files.pages IS 'Pages array or page count from extraction'
        `);
        await client.query(`
            COMMENT ON COLUMN job_files.extraction_time_seconds IS 'Time taken for extraction in seconds'
        `);
        await client.query(`
            COMMENT ON COLUMN job_files.openai_feed_blocked IS 'Blocked markdown feed for OpenAI with [BLOCK: id] markers'
        `);
        await client.query(`
            COMMENT ON COLUMN job_files.openai_feed_unblocked IS 'Unblocked markdown feed for OpenAI without block markers'
        `);
        await client.query(`
            COMMENT ON COLUMN job_files.extraction_metadata IS 'Metadata from extraction including method, lengths, counts, etc.'
        `);

        console.log('✅ Added comments to new columns');

    } catch (error) {
        console.error('❌ Error adding PaddleOCR columns:', error.message);
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

// Run the migration
if (import.meta.url === `file://${process.argv[1]}`) {
    addPaddleOCRFields()
        .then(() => {
            console.log('🎉 Migration completed successfully!');
            process.exit(0);
        })
        .catch((error) => {
            console.error('💥 Migration failed:', error);
            process.exit(1);
        });
}

export { addPaddleOCRFields };

