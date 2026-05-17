/**
 * Migration: Preview page analytics (public preview monitoring)
 * Tracks anonymous sessions (IP / UA), wells viewed, and wellbore diagram usage.
 */

import pool from '../src/database.js';

async function addPreviewAnalytics() {
    const client = await pool.connect();

    try {
        console.log('Creating preview analytics tables...');

        await client.query(`
            CREATE TABLE IF NOT EXISTS preview_analytics_sessions (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                preview_id UUID NOT NULL,
                client_session_id VARCHAR(64) NOT NULL,
                ip_address VARCHAR(45),
                user_agent TEXT,
                accept_language VARCHAR(255),
                referer TEXT,
                country_code VARCHAR(8),
                region VARCHAR(128),
                first_seen_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
                last_seen_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (preview_id, client_session_id)
            )
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_preview_analytics_sessions_preview
            ON preview_analytics_sessions (preview_id, last_seen_at DESC)
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS preview_analytics_events (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                session_id UUID NOT NULL REFERENCES preview_analytics_sessions(id) ON DELETE CASCADE,
                preview_id UUID NOT NULL,
                event_type VARCHAR(64) NOT NULL,
                job_file_id UUID,
                well_label VARCHAR(512),
                metadata JSONB NOT NULL DEFAULT '{}',
                created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_preview_analytics_events_preview_created
            ON preview_analytics_events (preview_id, created_at DESC)
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_preview_analytics_events_type
            ON preview_analytics_events (preview_id, event_type, created_at DESC)
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_preview_analytics_events_well
            ON preview_analytics_events (preview_id, job_file_id)
            WHERE job_file_id IS NOT NULL
        `);

        console.log('✅ Preview analytics tables ready');
    } finally {
        client.release();
    }
}

async function runMigration() {
    try {
        await addPreviewAnalytics();
        console.log('🎉 Migration completed successfully');
        process.exit(0);
    } catch (error) {
        console.error('💥 Migration failed:', error);
        process.exit(1);
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    runMigration();
}

export default addPreviewAnalytics;
