#!/usr/bin/env node
/**
 * Database Migration: Add classifier_hints to document_types
 *
 * Adds an optional column `document_types.classifier_hints` (JSONB).
 *
 * Why: the visual page classifier (Phase 1, item #2) defaults to "anything
 * that visually resembles document type X gets classified as X". On real
 * documents that's wrong in two ways:
 *
 *   1. Type confusion. Pages that look adjacent to a real X (e.g. permit
 *      forms next to a well log) get falsely classified as X. The model
 *      needs to be told "here's what looks like X but isn't".
 *
 *   2. Purpose over-counting. Pages that ARE type X but contain redundant /
 *      supplemental content (a re-scan, an "as-built" copy, an abandonment
 *      form repeating earlier construction details) get marked
 *      page_purpose='data' and feed extraction redundantly. The model needs
 *      to be told "here's what counts as data for X — and what doesn't".
 *
 * Both problems are document-type-specific. They live on document_types
 * rather than on schemas because:
 *   - They describe the document type generically; they don't change with
 *     each schema version.
 *   - They're orthogonal to extraction-prompt hints (the existing
 *     `prompt_hints` on schemas).
 *
 * Shape (documented; not enforced by Postgres):
 *   {
 *     "skip_when": [
 *       "free-text rule the classifier will see in the system prompt",
 *       "..."
 *     ],
 *     "keep_when": [
 *       "free-text positive signal the classifier will see",
 *       "..."
 *     ],
 *     "examples": {              // optional, future
 *       "skip": [...],
 *       "keep": [...]
 *     }
 *   }
 *
 * Empty object / null → no per-type hints (current behaviour for new types).
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

async function addClassifierHintsColumn() {
    const client = await pool.connect();
    try {
        console.log('🔄 Adding classifier_hints column to document_types...');
        await client.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'document_types' AND column_name = 'classifier_hints'
                ) THEN
                    ALTER TABLE document_types
                    ADD COLUMN classifier_hints JSONB NOT NULL DEFAULT '{}'::jsonb;
                    COMMENT ON COLUMN document_types.classifier_hints IS
                        'Per-type guidance for the visual page classifier. Contains skip_when / keep_when free-text rules spliced into the classifier prompt. See ai/migrations/add_classifier_hints_to_document_types.js for shape.';
                ELSE
                    RAISE NOTICE 'document_types.classifier_hints already exists';
                END IF;
            END $$
        `);
        console.log('✅ document_types.classifier_hints column ready');
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
    addClassifierHintsColumn()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
}

export { addClassifierHintsColumn };
