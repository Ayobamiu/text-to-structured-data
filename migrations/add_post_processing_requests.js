#!/usr/bin/env node
/**
 * Database Migration: post_processing_requests
 *
 * One row per post-processing backfill request (job settings → "Run
 * service"). Mirrors directed_reextraction_requests: the row is both the
 * queue payload and the audit record.
 *
 *  - Queue payload: the run rides file_processing_queue as
 *    `psvc:<requestId>`, with one item PER FILE. Per-file items (rather than
 *    one job-sized item) matter because the worker processes items serially:
 *    a 4000-file backfill as a single item would starve every upload behind
 *    it, and a crash would lose the whole run. Per file, the backfill
 *    interleaves with normal processing and resumes where it stopped.
 *  - Audit/progress: total_files / processed_files drive the live
 *    `postprocess-progress-event` banner, and `summary` accumulates the
 *    ApplyResult (counters, per-service applied/skipped/error, precision
 *    tiers) across every file — read back by GET /jobs/:id/post-processing
 *    so a reload can still show a run in flight.
 *
 * apply=false is a dry run: services still execute for real counts, nothing
 * is written. status: queued → processing → completed | failed.
 *
 * RLS is enabled with no policies, matching the 2026-07-21 hardening: the
 * backend connects as `postgres` (BYPASSRLS) and the web app has no anon
 * key, so this denies everything else by default.
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

async function addPostProcessingRequests() {
    const client = await pool.connect();
    try {
        console.log('🔄 Creating post_processing_requests table...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS post_processing_requests (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
                service TEXT NOT NULL,
                slug TEXT NOT NULL,
                options JSONB NOT NULL DEFAULT '{}'::jsonb,
                apply BOOLEAN NOT NULL DEFAULT false,
                force BOOLEAN NOT NULL DEFAULT false,
                status TEXT NOT NULL DEFAULT 'queued',
                total_files INTEGER NOT NULL DEFAULT 0,
                processed_files INTEGER NOT NULL DEFAULT 0,
                summary JSONB NOT NULL DEFAULT '{}'::jsonb,
                error TEXT,
                requested_by TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);
        // The UI asks for "the latest request on this job".
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_post_processing_requests_job
                ON post_processing_requests (job_id, created_at DESC)
        `);
        await client.query(`
            ALTER TABLE post_processing_requests ENABLE ROW LEVEL SECURITY
        `);
        await client.query(`
            COMMENT ON TABLE post_processing_requests IS
                'Post-processing backfill requests: queue payload for psvc:<id> items on file_processing_queue (one per file) AND the accumulated summary/progress of each run. See ai/migrations/add_post_processing_requests.js.'
        `);
        console.log('✅ post_processing_requests table ready');
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
    addPostProcessingRequests()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
}

export { addPostProcessingRequests };
