#!/usr/bin/env node
/**
 * Database Migration: Add corrected_value to section_qa_findings
 *
 * Adds an optional column `section_qa_findings.corrected_value` (JSONB).
 *
 * Why: `expected` is defined as a VERBATIM quote of page text — evidence for
 * a human to trust, not necessarily a value that can be injected directly
 * into the record. For most scalar fields the quoted text happens to equal
 * the correct value, so this worked by coincidence. It breaks for derived/
 * boolean fields: e.g. a boring log's last row has the note "EOB = 68.0
 * FEET" (the evidence), but the record's boolean `eob` field should become
 * `true` — a value nowhere written as the literal word "true" on the page.
 * The client's apply-a-finding flow (coerceExpected in web/src/lib/
 * jsonPath.ts) tried to coerce "EOB = 68.0 FEET" into a boolean and silently
 * produced `false` — a no-op that looks like nothing happened.
 *
 * corrected_value gives the model a second, explicitly-typed field for the
 * actual answer (string | number | boolean | null), separate from the
 * evidence quote in `expected`. Both the server's verification logic
 * (verifyFindingAgainstRecord in sectionQAService.js) and the client's apply
 * flow use corrected_value directly when present, instead of re-deriving a
 * typed value from evidence text.
 *
 * Null is a legitimate value here — it means issue_type="extra_value"
 * (remove, don't replace) or a row-count issue type (no single value
 * applies) — so the column has no NOT NULL constraint. Findings created
 * before this migration will have corrected_value=NULL; the verification
 * and apply logic both fall back to the pre-existing expected/actual
 * string-based path when corrected_value is absent.
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

async function addCorrectedValueColumn() {
    const client = await pool.connect();
    try {
        console.log('🔄 Adding corrected_value column to section_qa_findings...');
        await client.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'section_qa_findings' AND column_name = 'corrected_value'
                ) THEN
                    ALTER TABLE section_qa_findings
                    ADD COLUMN corrected_value JSONB;
                    COMMENT ON COLUMN section_qa_findings.corrected_value IS
                        'Typed replacement value (string/number/boolean/null) for actual, distinct from the verbatim evidence quote in expected. Null for extra_value (remove) and row-count issue types (no single value applies), or for findings created before this column existed. See ai/migrations/add_corrected_value_to_section_qa_findings.js.';
                ELSE
                    RAISE NOTICE 'section_qa_findings.corrected_value already exists';
                END IF;
            END $$
        `);
        console.log('✅ section_qa_findings.corrected_value column ready');
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
    addCorrectedValueColumn()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
}

export { addCorrectedValueColumn };
