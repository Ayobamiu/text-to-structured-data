#!/usr/bin/env node
/**
 * Public self-serve demo sessions (coreextract.app drop zone).
 *
 * Isolated from customer orgs: jobs are created under the demo org, and this
 * table holds the capability token + lead/export events for follow-up.
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

const DDL = `
CREATE TABLE IF NOT EXISTS demo_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash VARCHAR(64) NOT NULL,
    job_id UUID REFERENCES jobs(id) ON DELETE SET NULL,
    file_id UUID REFERENCES job_files(id) ON DELETE SET NULL,
    filename TEXT,
    page_count INTEGER,
    document_type TEXT,
    status VARCHAR(40) NOT NULL DEFAULT 'queued',
    ip_address TEXT,
    user_agent TEXT,
    lead_email TEXT,
    download_token_hash VARCHAR(64),
    download_token_expires_at TIMESTAMPTZ,
    downloaded_at TIMESTAMPTZ,
    notified_classified_at TIMESTAMPTZ,
    notified_completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days')
);
`;

async function addDemoSessions() {
    const client = await pool.connect();
    try {
        console.log('🔄 Creating demo_sessions...');
        await client.query(DDL);
        await client.query(`
            ALTER TABLE demo_sessions
                ADD COLUMN IF NOT EXISTS download_token_hash VARCHAR(64)
        `);
        await client.query(`
            ALTER TABLE demo_sessions
                ADD COLUMN IF NOT EXISTS download_token_expires_at TIMESTAMPTZ
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_demo_sessions_token_hash
                ON demo_sessions (token_hash);
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_demo_sessions_ip_created
                ON demo_sessions (ip_address, created_at DESC);
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_demo_sessions_file_id
                ON demo_sessions (file_id);
        `);
        console.log('✅ demo_sessions ready');
    } catch (error) {
        console.error('❌ Migration failed:', error.message);
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    addDemoSessions()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
}

export { addDemoSessions, DDL as DEMO_SESSIONS_DDL };
