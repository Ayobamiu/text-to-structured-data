#!/usr/bin/env node
/**
 * Database Migration: Add markdown column to job_files table
 * Run this script to add the markdown field to existing databases
 */

import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

const pool = new Pool({
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'batch_processor',
    password: process.env.DB_PASSWORD || 'password',
    port: process.env.DB_PORT || 5432,
});

async function addMarkdownColumn() {
    const client = await pool.connect();
    try {
        console.log('🔄 Adding markdown column to job_files table...');

        // Check if column already exists
        const checkQuery = `
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name = 'job_files' AND column_name = 'markdown'
        `;
        const checkResult = await client.query(checkQuery);

        if (checkResult.rows.length > 0) {
            console.log('✅ markdown column already exists in job_files table');
            return;
        }

        // Add the markdown column
        const alterQuery = `
            ALTER TABLE job_files 
            ADD COLUMN markdown TEXT
        `;

        await client.query(alterQuery);
        console.log('✅ Successfully added markdown column to job_files table');

        // Add comment to the column
        const commentQuery = `
            COMMENT ON COLUMN job_files.markdown IS 'Markdown formatted content from Document AI + V3 converter'
        `;

        await client.query(commentQuery);
        console.log('✅ Added comment to markdown column');

    } catch (error) {
        console.error('❌ Error adding markdown column:', error.message);
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

// Run the migration
if (import.meta.url === `file://${process.argv[1]}`) {
    addMarkdownColumn()
        .then(() => {
            console.log('🎉 Migration completed successfully!');
            process.exit(0);
        })
        .catch((error) => {
            console.error('💥 Migration failed:', error);
            process.exit(1);
        });
}

export { addMarkdownColumn };
