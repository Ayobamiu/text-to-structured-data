#!/usr/bin/env node
/**
 * Database Migration: directed_reextraction_requests
 *
 * One row per directed group re-extraction request (the "Fix a group with
 * AI…" operator action). The row is BOTH the queue payload and the audit
 * record:
 *
 *  - Queue payload: the job rides file_processing_queue with mode
 *    `rex:<requestId>` (same no-new-queue-columns trick as `qa:*` jobs, but
 *    the free-text operator prompt / groups / pages can't be encoded in a
 *    mode string, so they live here and the mode string carries only the id).
 *  - Audit/telemetry: every directed run is a paired-data record for the
 *    vision-extraction A/B — what was wrong (prompt), what vision read
 *    (result jsonb: per-group mode used, findings count, tokens, duration),
 *    and later what the operator accepted (joinable to section_qa_findings).
 *
 * status: queued → processing → completed | failed. Requests in
 * queued/processing back the dedupe check (one active request per section)
 * and client-reload hydration via GET /files/:id/qa-findings.
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

async function addDirectedReextractionRequests() {
    const client = await pool.connect();
    try {
        console.log('🔄 Creating directed_reextraction_requests table...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS directed_reextraction_requests (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                file_id UUID NOT NULL,
                section_result_id UUID NOT NULL,
                slug TEXT NOT NULL,
                groups TEXT[] NOT NULL,
                pages INTEGER[] NOT NULL,
                prompt TEXT,
                mode TEXT NOT NULL DEFAULT 'auto',
                model TEXT,
                status TEXT NOT NULL DEFAULT 'queued',
                error TEXT,
                result JSONB,
                requested_by TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_dre_requests_file
                ON directed_reextraction_requests (file_id)
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_dre_requests_section_active
                ON directed_reextraction_requests (section_result_id)
                WHERE status IN ('queued', 'processing')
        `);
        await client.query(`
            COMMENT ON TABLE directed_reextraction_requests IS
                'Directed group re-extraction requests: queue payload for rex:<id> jobs on file_processing_queue AND the audit/telemetry record of each vision repair run. See ai/migrations/add_directed_reextraction_requests.js.'
        `);
        console.log('✅ directed_reextraction_requests table ready');
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
    addDirectedReextractionRequests()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
}

export { addDirectedReextractionRequests };
