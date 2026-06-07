#!/usr/bin/env node
/**
 * Database Migration: Add file_processing_events
 *
 * A curated, structured timeline of what happened while a file was processed —
 * the safe, frontend-facing version of the worker's console logs. The worker
 * writes one row per meaningful step (phase transitions, classifier batch
 * progress, per-section extraction progress, warnings) and emits the same
 * payload over the socket as `file-processing-event`. The table lets a client
 * that opens/refreshes a file AFTER (or mid) processing replay the timeline.
 *
 * IMPORTANT: rows are curated — never raw logs. No signed URLs, no secrets.
 *
 * Columns:
 *   phase      queued | classifying | extracting | ai_extraction | post_processing | done | failed | skipped
 *   step       optional finer label within a phase
 *   status     active | done | failed | info
 *   progress_* current/total for determinate phases (batch N/M, section N/M)
 *   level      info | warning | error
 *   data       small JSONB payload (durations, eta_ms, section name, counts)
 *   seq        BIGSERIAL — stable global ordering even within the same ms
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

async function addFileProcessingEvents() {
    const client = await pool.connect();
    try {
        console.log('🔄 Creating file_processing_events...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS file_processing_events (
                id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                seq              BIGSERIAL,
                file_id          UUID NOT NULL,
                job_id           UUID,
                phase            VARCHAR(40) NOT NULL,
                step             VARCHAR(80),
                status           VARCHAR(20) NOT NULL DEFAULT 'info',
                progress_current INTEGER,
                progress_total   INTEGER,
                message          TEXT,
                level            VARCHAR(10) NOT NULL DEFAULT 'info',
                data             JSONB,
                created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_fpe_file_seq
                ON file_processing_events (file_id, seq);
        `);
        await client.query(`
            COMMENT ON TABLE file_processing_events IS
                'Curated, frontend-facing processing timeline per file. One row per step. Never contains raw logs/secrets.';
        `);
        console.log('✅ file_processing_events ready');
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
    addFileProcessingEvents()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
}

export { addFileProcessingEvents };
