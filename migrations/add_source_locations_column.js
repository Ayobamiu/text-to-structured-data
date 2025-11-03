#!/usr/bin/env node
/**
 * Database Migration: Add source_locations column to job_files table
 * Adds: source_locations (JSONB) - stores source locations separately from result data
 * Run this script to add the new field to existing databases
 */

import pg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables from ai directory
dotenv.config({ path: join(__dirname, '..', '.env') });

const { Pool } = pg;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || `postgresql://${process.env.DB_USER || 'postgres'}:${process.env.DB_PASSWORD || 'password'}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 5432}/${process.env.DB_NAME || 'batch_processor'}`,
    family: 4,
});

async function addSourceLocationsColumn() {
    const client = await pool.connect();
    try {
        console.log('🔄 Adding source_locations column to job_files table...');

        // Check if column already exists
        const checkQuery = `
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name = 'job_files' AND column_name = 'source_locations'
        `;
        const existing = await client.query(checkQuery);

        if (existing.rows.length > 0) {
            console.log('✅ source_locations column already exists');
        } else {
            // Add source_locations column
            await client.query(`
                ALTER TABLE job_files 
                ADD COLUMN source_locations JSONB
            `);
            console.log('✅ Added source_locations column');

            // Add comment
            await client.query(`
                COMMENT ON COLUMN job_files.source_locations IS 'Source locations extracted from OpenAI result, stored separately from result data'
            `);
            console.log('✅ Added column comment');
        }

        console.log('✅ Migration completed successfully');
    } catch (error) {
        console.error('❌ Error adding source_locations column:', error.message);
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

// Run the migration
if (import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith(process.argv[1])) {
    addSourceLocationsColumn()
        .then(() => {
            console.log('🎉 Migration completed successfully!');
            process.exit(0);
        })
        .catch((error) => {
            console.error('💥 Migration failed:', error);
            process.exit(1);
        });
}

export { addSourceLocationsColumn };

