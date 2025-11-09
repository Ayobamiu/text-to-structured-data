#!/usr/bin/env node
/**
 * Database Migration: Add collaborators to jobs and comments to job_files
 * Adds: 
 *   - collaborators JSONB column to jobs table (array of {email, role})
 *   - comments JSONB column to job_files table (array of comment objects)
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

async function addCollaboratorsAndComments() {
    const client = await pool.connect();
    try {
        console.log('🔄 Adding collaborators and comments columns...');

        // Step 1: Add collaborators column to jobs table
        const checkCollaboratorsQuery = `
            SELECT column_name
            FROM information_schema.columns
            WHERE table_name = 'jobs'
              AND column_name = 'collaborators'
        `;
        const checkCollaboratorsResult = await client.query(checkCollaboratorsQuery);

        if (checkCollaboratorsResult.rows.length === 0) {
            await client.query(`
                ALTER TABLE jobs
                ADD COLUMN collaborators JSONB DEFAULT '[]'::jsonb
            `);
            await client.query(`
                COMMENT ON COLUMN jobs.collaborators IS 'Array of collaborators with email and role: [{"email": "user@example.com", "role": "reviewer"}]'
            `);
            console.log('✅ Added collaborators column to jobs table');
        } else {
            console.log('✅ collaborators column already exists in jobs table');
        }

        // Step 2: Add comments column to job_files table
        const checkCommentsQuery = `
            SELECT column_name
            FROM information_schema.columns
            WHERE table_name = 'job_files'
              AND column_name = 'comments'
        `;
        const checkCommentsResult = await client.query(checkCommentsQuery);

        if (checkCommentsResult.rows.length === 0) {
            await client.query(`
                ALTER TABLE job_files
                ADD COLUMN comments JSONB DEFAULT '[]'::jsonb
            `);
            await client.query(`
                COMMENT ON COLUMN job_files.comments IS 'Array of comments: [{"id": "uuid", "userId": "uuid", "userEmail": "string", "text": "string", "createdAt": "timestamp"}]'
            `);
            console.log('✅ Added comments column to job_files table');
        } else {
            console.log('✅ comments column already exists in job_files table');
        }

        // Step 3: Create index on collaborators for better query performance
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_jobs_collaborators 
            ON jobs USING GIN (collaborators)
        `);
        console.log('✅ Created index on jobs.collaborators');

        // Step 4: Create index on comments for better query performance
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_job_files_comments 
            ON job_files USING GIN (comments)
        `);
        console.log('✅ Created index on job_files.comments');

    } catch (error) {
        console.error('❌ Error adding collaborators and comments columns:', error.message);
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    addCollaboratorsAndComments()
        .then(() => {
            console.log('🎉 Migration completed successfully!');
            process.exit(0);
        })
        .catch((error) => {
            console.error('💥 Migration failed:', error);
            process.exit(1);
        });
}

export { addCollaboratorsAndComments };

