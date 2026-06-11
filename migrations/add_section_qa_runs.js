#!/usr/bin/env node
/**
 * Database Migration: add `section_qa_runs`.
 *
 * One row per (file_id, section_result_id), upserted every time QA runs on a
 * section — including a CLEAN pass that produces zero findings. `section_qa_findings`
 * stores a row per issue, so a clean pass leaves no trace there; this table is
 * the durable "QA ran on this section" signal the UI needs to show
 * "Re-run QA" / "Run remaining" correctly across reloads.
 *
 * Idempotent (CREATE TABLE / INDEX IF NOT EXISTS). Run:
 *   node migrations/add_section_qa_runs.js
 */

import pool from '../src/database.js';

async function main() {
    const client = await pool.connect();
    try {
        console.log('🔄 Creating section_qa_runs...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS section_qa_runs (
                file_id           UUID NOT NULL,
                section_result_id UUID NOT NULL,
                overall_quality   VARCHAR(20),
                summary           TEXT,
                findings_count    INTEGER NOT NULL DEFAULT 0,
                qa_model          VARCHAR(100),
                last_qa_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
                created_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
                updated_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
                PRIMARY KEY (file_id, section_result_id)
            )
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_section_qa_runs_file
                ON section_qa_runs (file_id)
        `);
        await client.query(`
            COMMENT ON TABLE section_qa_runs IS
                'One row per section per file marking that QA ran (incl. clean passes); drives Re-run/Run-remaining UI'
        `);
        console.log('✅ section_qa_runs ready');
    } catch (err) {
        console.error('❌ migration failed:', err.message);
        throw err;
    } finally {
        client.release();
        await pool.end();
    }
}

main().catch(() => process.exit(1));
