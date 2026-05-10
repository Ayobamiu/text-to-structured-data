#!/usr/bin/env node
/**
 * Database Migration: Add detected_sections to job_files
 *
 * Adds a single optional column `job_files.detected_sections` (JSONB).
 *
 * Why: the visual page classifier (Phase 1, item #2) writes one row of
 *      classifications per file before extraction, then the section grouper
 *      collapses consecutive same-type pages into sections. The result lives
 *      here so:
 *        - it's idempotent (re-runs of the worker don't reclassify),
 *        - the worker can use it to scope OCR to relevant pages only,
 *        - the routing-review UI (item #4) reads it directly,
 *        - per-section extraction (item #3) iterates over it.
 *
 * Shape (documented for downstream readers — not enforced by Postgres):
 *   {
 *     "classifier": {
 *       "name": "openai-vision",
 *       "model": "gpt-4o-mini",
 *       "version": 1,
 *       "ran_at": "ISO-8601",
 *       "duration_ms": 12345,
 *       "page_count": 200,
 *       "image": { "width": 768, "detail": "low" }
 *     },
 *     "pages": [
 *       { "page_number": 1, "document_type_slug": "mgs_well_log",
 *         "page_role": "first", "confidence": 0.94, "reasoning": "..." }
 *     ],
 *     "sections": [
 *       { "document_type_slug": "mgs_well_log",
 *         "page_range": [1, 3],
 *         "page_count": 3,
 *         "confidence": 0.92,
 *         "min_page_confidence": 0.88,
 *         "page_roles": ["first", "middle", "last"] }
 *     ],
 *     "status": "pending_review" | "auto_approved" | "approved" | "skipped"
 *   }
 *
 * `status` is forward-looking: today the classifier writes "auto_approved"
 * when the section minimum confidence is at or above the document_type's
 * routing_confidence_threshold, and "pending_review" otherwise. The routing
 * review UI (item #4) flips "pending_review" → "approved" once a human signs
 * off. Per-section extraction only runs on "auto_approved" or "approved"
 * sections.
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

async function addDetectedSectionsToJobFiles() {
    const client = await pool.connect();
    try {
        console.log('🔄 Adding detected_sections column to job_files...');

        await client.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'job_files' AND column_name = 'detected_sections'
                ) THEN
                    ALTER TABLE job_files ADD COLUMN detected_sections JSONB;
                    COMMENT ON COLUMN job_files.detected_sections IS
                        'Output of the visual page classifier: per-page classifications + grouped sections + classifier metadata. See ai/migrations/add_detected_sections_to_job_files.js for shape.';
                ELSE
                    RAISE NOTICE 'job_files.detected_sections already exists';
                END IF;
            END $$
        `);

        // Functional index for the most common future query: "find files
        // where any section is pending routing review."
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_job_files_detected_sections_status
            ON job_files ((detected_sections->>'status'))
        `);

        console.log('✅ job_files.detected_sections column ready');
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
    addDetectedSectionsToJobFiles()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
}

export { addDetectedSectionsToJobFiles };
