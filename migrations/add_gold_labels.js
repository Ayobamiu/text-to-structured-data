#!/usr/bin/env node
/**
 * Database Migration: add `gold_batches` + `gold_labels`.
 *
 * The missing negatives. `section_qa_findings` records only errors somebody
 * caught — there is no row meaning "a human checked this field and it was
 * fine" — so per-field ACCURACY has no denominator and cannot be computed from
 * production data at all. A gold set supplies those negatives: a reviewer
 * walks a stratified sample and records a verdict for EVERY field in scope,
 * correct ones included.
 *
 * These are deliberately NOT stored in `section_qa_findings`. That table is
 * model-flagged issues, and its rows are what the 83.7% QA precision figure is
 * computed from; pouring thousands of human-confirmed negatives into it would
 * corrupt that number.
 *
 * Seeded by scripts/goldSetSample.mjs --write, filled by the review panel in
 * the file viewer, scored by scripts/goldSetScore.mjs --batch.
 *
 * Idempotent (CREATE ... IF NOT EXISTS). Run:
 *   node migrations/add_gold_labels.js
 */

import pool from '../src/database.js';

async function main() {
    const client = await pool.connect();
    try {
        console.log('🔄 Creating gold_batches...');
        // One row per sample draw. Without the seed parameters a batch cannot
        // be reproduced or defended later ("how were these 60 chosen?").
        await client.query(`
            CREATE TABLE IF NOT EXISTS gold_batches (
                batch        TEXT PRIMARY KEY,
                slug         VARCHAR(100) NOT NULL,
                n_sections   INTEGER NOT NULL DEFAULT 0,
                per_file     INTEGER NOT NULL DEFAULT 0,
                seed         INTEGER NOT NULL DEFAULT 0,
                field_mode   VARCHAR(20) NOT NULL DEFAULT 'core',
                include_qad  BOOLEAN NOT NULL DEFAULT FALSE,
                notes        TEXT,
                created_by   UUID REFERENCES users(id),
                created_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
            )
        `);

        // Labels a reviewer records OUTSIDE the stratified sample (hovering a
        // field in the tree that was never seeded) land here. Kept, because
        // they are free signal — but a separate batch, so they can never drift
        // into the headline accuracy number, which depends on the sample being
        // the one that was drawn.
        await client.query(`
            INSERT INTO gold_batches (batch, slug, field_mode, notes)
            VALUES ('adhoc', 'mixed', 'adhoc',
                    'Opportunistic labels recorded outside any stratified sample. Never scored as a batch.')
            ON CONFLICT (batch) DO NOTHING
        `);

        console.log('🔄 Creating gold_labels...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS gold_labels (
                id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                batch             TEXT NOT NULL REFERENCES gold_batches(batch) ON DELETE CASCADE,
                file_id           UUID NOT NULL REFERENCES job_files(id) ON DELETE CASCADE,
                job_id            UUID,
                section_result_id UUID NOT NULL,
                slug              VARCHAR(100) NOT NULL,
                field_path        TEXT NOT NULL,
                extracted_value   TEXT,
                qa_ran            BOOLEAN NOT NULL DEFAULT FALSE,
                verdict           VARCHAR(20),
                true_value        TEXT,
                notes             TEXT,
                reviewed_by       UUID REFERENCES users(id),
                reviewed_at       TIMESTAMP WITH TIME ZONE,
                created_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
                updated_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
                UNIQUE (batch, section_result_id, field_path)
            )
        `);

        // The vocabulary has to match scripts/goldSetScore.mjs exactly: a
        // verdict the scorer does not recognise falls silently into "unscored"
        // and the row is lost from the denominator.
        await client.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM pg_constraint WHERE conname = 'gold_labels_verdict_check'
                ) THEN
                    ALTER TABLE gold_labels ADD CONSTRAINT gold_labels_verdict_check
                        CHECK (verdict IS NULL OR verdict IN ('correct', 'wrong', 'missing', 'unreadable'));
                END IF;
            END $$
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_gold_labels_batch_file
                ON gold_labels (batch, file_id)
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_gold_labels_section
                ON gold_labels (section_result_id)
        `);
        // "Where do I go next" — the review queue reads only pending rows.
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_gold_labels_pending
                ON gold_labels (batch, file_id, section_result_id)
             WHERE verdict IS NULL
        `);

        // Every public table has RLS on since the 2026-07-21 sweep (no
        // policies; the backend connects as postgres, which bypasses it, and
        // the web app has no anon key). A new table without it re-opens an
        // advisor ERROR.
        await client.query('ALTER TABLE gold_batches ENABLE ROW LEVEL SECURITY');
        await client.query('ALTER TABLE gold_labels  ENABLE ROW LEVEL SECURITY');

        await client.query(`
            COMMENT ON TABLE gold_labels IS
                'Human verdicts on every field in a stratified sample, correct ones included — the negatives section_qa_findings can never hold. Denominator for per-field accuracy.'
        `);
        await client.query(`
            COMMENT ON TABLE gold_batches IS
                'One row per gold-set sample draw, carrying the seed parameters that make the sample reproducible'
        `);

        console.log('✅ gold_batches + gold_labels ready');
    } catch (err) {
        console.error('❌ migration failed:', err.message);
        throw err;
    } finally {
        client.release();
        await pool.end();
    }
}

main().catch(() => process.exit(1));
