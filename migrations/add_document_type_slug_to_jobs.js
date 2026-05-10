#!/usr/bin/env node
/**
 * Database Migration: Add document_type_slug to jobs
 *
 * Adds a single optional column `jobs.document_type_slug` (VARCHAR(100)).
 *
 * Why: when a reviewer edits a result via PUT /files/:id/results, the
 * field_corrections logger needs to know which document_type the row belongs
 * to. For v2 (typed-section) results, the slug is recoverable from the
 * json_path (sections.<slug>[i]....). For v1 (today's flat results) it isn't,
 * so the caller has to supply a fallback. Reading jobs.document_type_slug at
 * save time gives us that fallback for the dominant historical case.
 *
 * Intentionally NOT a foreign key to document_types(slug):
 *   - Keeps job creation independent of registry seeding order.
 *   - Lets us populate this column lazily for legacy jobs without
 *     requiring matching registry rows yet.
 *   - Validation happens at the application layer when the registry-based
 *     job creation flow lands (Phase 1+).
 *
 * Idempotent — safe to re-run.
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
    connectionString:
        process.env.DATABASE_URL ||
        `postgresql://${process.env.DB_USER || 'postgres'}:${process.env.DB_PASSWORD || 'password'}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 5432}/${process.env.DB_NAME || 'batch_processor'}`,
    family: 4,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

async function addDocumentTypeSlugToJobs() {
    const client = await pool.connect();
    try {
        console.log('🔄 Adding document_type_slug column to jobs...');

        await client.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'jobs' AND column_name = 'document_type_slug'
                ) THEN
                    ALTER TABLE jobs ADD COLUMN document_type_slug VARCHAR(100);
                    COMMENT ON COLUMN jobs.document_type_slug IS
                        'Optional slug pointing at document_types.slug. Used as a fallback for field_corrections logging when the result blob is v1 (flat) and the json_path does not encode the section type. Not a hard FK to keep job creation independent of registry seeding.';
                ELSE
                    RAISE NOTICE 'jobs.document_type_slug already exists';
                END IF;
            END $$
        `);

        await client.query(
            `CREATE INDEX IF NOT EXISTS idx_jobs_document_type_slug ON jobs(document_type_slug)`
        );

        console.log('✅ jobs.document_type_slug column ready');
        console.log('🎉 Migration complete');
    } catch (error) {
        console.error('❌ Migration failed:', error.message);
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    addDocumentTypeSlugToJobs()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
}

export { addDocumentTypeSlugToJobs };
