#!/usr/bin/env node
/**
 * Database Migration: Add token telemetry to section_qa_runs
 *
 * Adds a nullable `tokens` JSONB column:
 *   { prompt_tokens, completion_tokens, total_tokens, cached_tokens }
 *
 * Why: per-group QA cost was only visible in console log lines, so there was
 * no durable data to (a) know what QA actually costs per section/model, or
 * (b) measure any cost-reduction candidate (group batching, model tiering)
 * against reality. saveQAFindings now persists the totals runGroupedQA was
 * already counting. Old rows stay NULL; the service tolerates a missing
 * column (pre-migration DB) by skipping the write, so deploy order is safe
 * either way.
 *
 * Run: DATABASE_URL=$DEV_DATABASE_URL node migrations/add_tokens_to_section_qa_runs.js
 */
import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
});

try {
    await client.connect();
    await client.query(`
        ALTER TABLE section_qa_runs
        ADD COLUMN IF NOT EXISTS tokens JSONB
    `);
    const check = await client.query(`
        SELECT column_name, data_type FROM information_schema.columns
        WHERE table_name = 'section_qa_runs' AND column_name = 'tokens'
    `);
    console.log('✅ section_qa_runs.tokens:', check.rows[0] || 'MISSING (unexpected)');
} catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exitCode = 1;
} finally {
    await client.end();
}
