#!/usr/bin/env node
/**
 * Database Migration: Add qa_hints to document_types
 *
 * Adds an optional column `document_types.qa_hints` (JSONB).
 *
 * Why: post-extraction QA (sectionQAService.js) reviews an entire section
 * record against page images in one shot with a generic, one-size-fits-all
 * prompt. In production that produces low-signal findings — trivial
 * administrative fields (e.g. total_pages) get flagged while real errors in
 * the fields reviewers actually care about (e.g. lithology_intervals depths)
 * get missed. The QA prompt has no notion of which fields in a given
 * document type's schema matter.
 *
 * qa_hints gives each document type a place to say, per top-level schema
 * field-group: how much scrutiny it deserves, and which fields to skip
 * entirely. Mirrors the existing `classifier_hints` column/pattern (see
 * add_classifier_hints_to_document_types.js) — same jsonb-on-document_types
 * shape, same registry read/write functions, same admin-editable JSON blob.
 *
 * Shape (documented; not enforced by Postgres), keyed by top-level schema
 * property name:
 *   {
 *     "lithology_intervals": {
 *       "priority": "critical",
 *       "notes": "free-text guidance spliced into the QA system prompt"
 *     },
 *     "document_metadata": {
 *       "priority": "low",
 *       "ignore": ["total_pages", "page_number"]
 *     }
 *   }
 *
 * priority: "critical" | "high" | "normal" | "low" — how much scrutiny this
 *   group gets relative to others in the same call.
 * ignore: field names within the group the model should never flag.
 * notes: free-text guidance for this group specifically.
 * skip: true — exclude the group from QA entirely (no per-group call is made
 *   for it). Use for pipeline-housekeeping groups like extraction_metadata.
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

async function addQAHintsColumn() {
    const client = await pool.connect();
    try {
        console.log('🔄 Adding qa_hints column to document_types...');
        await client.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'document_types' AND column_name = 'qa_hints'
                ) THEN
                    ALTER TABLE document_types
                    ADD COLUMN qa_hints JSONB NOT NULL DEFAULT '{}'::jsonb;
                    COMMENT ON COLUMN document_types.qa_hints IS
                        'Per-type, per-field-group guidance for post-extraction QA. Keyed by top-level schema property name; each entry may set priority (critical/high/normal/low), ignore (field names to never flag), and notes (free text) spliced into the QA system prompt. See ai/migrations/add_qa_hints_to_document_types.js for shape.';
                ELSE
                    RAISE NOTICE 'document_types.qa_hints already exists';
                END IF;
            END $$
        `);
        console.log('✅ document_types.qa_hints column ready');
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
    addQAHintsColumn()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
}

export { addQAHintsColumn };
