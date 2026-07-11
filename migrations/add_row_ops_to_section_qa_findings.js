#!/usr/bin/env node
/**
 * Database Migration: Add row-level op support to section_qa_findings
 *
 * Adds `row_index` (INTEGER) and `row_value` (JSONB) columns, and widens two
 * existing constraints to accommodate three new issue_type values: add_row,
 * update_row, delete_row.
 *
 * Why: missing_rows/extra_rows/wrong_count are diagnostic-only — a "row
 * count" isn't a single value, so nothing could ever be Applied for them
 * (only Accept/Dismiss). The new types let the model propose an actual fix
 * when it can identify the SPECIFIC row: delete_row (row_index, no value),
 * add_row (row_value, optional row_index for insertion position), update_row
 * (both). See ai/src/services/sectionQAService.js (verifyStructuredRowFinding)
 * and ai/src/config/openaiPrompts.ts (SECTION_QA_ISSUE_SCHEMA) for how these
 * are produced/verified.
 *
 * Two constraint changes beyond the new columns:
 *
 *   1. section_qa_findings_issue_type_check (CHECK) must allow the three new
 *      values or every row-op INSERT fails.
 *
 *   2. section_qa_findings_file_id_section_result_id_field_path_is_key
 *      (UNIQUE on file_id, section_result_id, field_path, issue_type) does
 *      not distinguish WHICH row a row-op targets. Two separate delete_row
 *      findings on the same array (e.g. rows 0 and 5 of lithology_intervals)
 *      share the same (field_path, issue_type) and would collide via
 *      ON CONFLICT ... DO UPDATE in saveQAFindings, silently clobbering one
 *      with the other. Widening the constraint to include row_index fixes
 *      this — but a plain UNIQUE(..., row_index) would break today's
 *      behavior for every EXISTING scalar finding, where row_index is always
 *      NULL: standard SQL NULL is never equal to NULL, so those rows would
 *      stop deduping/upserting on re-run and start accumulating duplicates
 *      instead. `UNIQUE NULLS NOT DISTINCT` (Postgres 15+) treats NULL as
 *      equal to NULL for this constraint, preserving today's scalar-finding
 *      behavior (including "a dismissed finding that recurs stays dismissed
 *      instead of reappearing as open") while giving row ops real per-index
 *      uniqueness.
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

const NEW_ISSUE_TYPES = [
    'wrong_value', 'missing_value', 'extra_value',
    'missing_rows', 'extra_rows', 'wrong_count', 'formatting',
    'add_row', 'update_row', 'delete_row',
];

async function addRowOpsSupport() {
    const client = await pool.connect();
    try {
        console.log('Adding row_index/row_value columns to section_qa_findings...');
        await client.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'section_qa_findings' AND column_name = 'row_index'
                ) THEN
                    ALTER TABLE section_qa_findings ADD COLUMN row_index INTEGER;
                    COMMENT ON COLUMN section_qa_findings.row_index IS
                        '0-indexed position within the target array. Required for delete_row/update_row; optional insertion position for add_row (null = append). Null for every other issue_type.';
                ELSE
                    RAISE NOTICE 'section_qa_findings.row_index already exists';
                END IF;

                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'section_qa_findings' AND column_name = 'row_value'
                ) THEN
                    ALTER TABLE section_qa_findings ADD COLUMN row_value JSONB;
                    COMMENT ON COLUMN section_qa_findings.row_value IS
                        'Full row object for add_row/update_row, in the target array item shape. Null for delete_row and every other issue_type.';
                ELSE
                    RAISE NOTICE 'section_qa_findings.row_value already exists';
                END IF;
            END $$
        `);
        console.log('columns ready');

        console.log('Widening issue_type CHECK constraint...');
        await client.query(`
            ALTER TABLE section_qa_findings
            DROP CONSTRAINT IF EXISTS section_qa_findings_issue_type_check
        `);
        // CHECK constraint bodies are DDL, not DML — they can't take bind
        // parameters. NEW_ISSUE_TYPES is a fixed literal list we control, so
        // inlining it is safe (not user input).
        const issueTypeList = NEW_ISSUE_TYPES.map((t) => `'${t}'::character varying`).join(', ');
        await client.query(`
            ALTER TABLE section_qa_findings
            ADD CONSTRAINT section_qa_findings_issue_type_check
            CHECK (issue_type::text = ANY (ARRAY[${issueTypeList}]::text[]))
        `);
        console.log('issue_type CHECK constraint widened');

        console.log('Widening uniqueness to include row_index (NULLS NOT DISTINCT)...');
        await client.query(`
            ALTER TABLE section_qa_findings
            DROP CONSTRAINT IF EXISTS section_qa_findings_file_id_section_result_id_field_path_is_key
        `);
        await client.query(`
            ALTER TABLE section_qa_findings
            ADD CONSTRAINT section_qa_findings_file_id_section_result_id_field_path_is_key
            UNIQUE NULLS NOT DISTINCT (file_id, section_result_id, field_path, issue_type, row_index)
        `);
        console.log('uniqueness constraint widened');

        console.log('Migration complete');
    } catch (error) {
        console.error('Migration failed:', error.message);
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    addRowOpsSupport()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
}

export { addRowOpsSupport };
