#!/usr/bin/env node
/**
 * Database Migration: file_processing_queue lease columns
 *
 * Adds `worker_id` + `heartbeat_at` so a worker can prove an in-flight item
 * is still being worked on, instead of every booting worker assuming that
 * anything in 'processing' was abandoned.
 *
 * That assumption is false during a rolling deploy — the new container boots
 * while the old one is still mid-file — and on 2026-07-30 it cost file
 * 924215a5 its 12-section v2 envelope: the duplicate run finished last and
 * overwrote `result` with a single flat record. The same thing at 01:07 that
 * day re-ran a directed re-extraction and re-billed the vision call.
 *
 * A timeout on processing_started_at was the obvious alternative and isn't
 * good enough: real files legitimately run ~30 min of extraction+AI (plus
 * ~14 min of classification on a 640-page document), so any threshold safe
 * against false steals would leave genuine crashes unrecovered for an hour.
 * The heartbeat is sized off the renewal interval (30s) instead, so recovery
 * stays ~2 minutes regardless of how long the job itself takes.
 *
 * Both columns are nullable: rows claimed before this migration have a null
 * heartbeat and fall back to processing_started_at, so nothing is stranded.
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

async function addQueueLease() {
    const client = await pool.connect();
    try {
        console.log('🔄 Adding lease columns to file_processing_queue...');
        await client.query(`
            ALTER TABLE file_processing_queue
                ADD COLUMN IF NOT EXISTS worker_id TEXT,
                ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ
        `);
        // The stale sweep filters on status + heartbeat age.
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_fpq_processing_heartbeat
                ON file_processing_queue (status, heartbeat_at)
                WHERE status = 'processing'
        `);
        await client.query(`
            COMMENT ON COLUMN file_processing_queue.worker_id IS
                'Worker process holding this item. Set on claim, cleared on stale requeue.'
        `);
        await client.query(`
            COMMENT ON COLUMN file_processing_queue.heartbeat_at IS
                'Last lease renewal. Requeue only when this is older than QUEUE_LEASE_STALE_SECONDS — see ai/migrations/add_queue_lease.js.'
        `);
        console.log('✅ file_processing_queue lease columns ready');
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
    addQueueLease()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
}

export { addQueueLease };
