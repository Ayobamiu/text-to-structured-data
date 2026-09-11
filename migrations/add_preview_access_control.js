/**
 * Migration: Add access-control columns to preview_data_table
 *
 * - expires_at  TIMESTAMPTZ NULL — public link stops working at/after this time
 *               (evaluated at request time; no cron required).
 * - status      VARCHAR(20) NOT NULL DEFAULT 'active' — 'active' | 'disabled'.
 *               'disabled' blocks access immediately, regardless of expiry.
 * - access_note TEXT NULL — optional message shown to visitors on the
 *               "access ended" page (e.g. who to contact to renew).
 *
 * Idempotent: safe to run multiple times.
 */

import pool from '../src/database.js';

async function addPreviewAccessControl() {
    const client = await pool.connect();

    try {
        console.log('Adding access-control columns to preview_data_table...');

        await client.query(`
            ALTER TABLE preview_data_table
                ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP WITH TIME ZONE,
                ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'active',
                ADD COLUMN IF NOT EXISTS access_note TEXT
        `);

        console.log('✅ preview_data_table access-control columns ready (expires_at, status, access_note)');

    } catch (error) {
        console.error('❌ Error adding access-control columns to preview_data_table:', error);
        throw error;
    } finally {
        client.release();
    }
}

async function runMigration() {
    try {
        await addPreviewAccessControl();
        console.log('🎉 Migration completed successfully');
        process.exit(0);
    } catch (error) {
        console.error('💥 Migration failed:', error);
        process.exit(1);
    }
}

// Run migration if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
    runMigration();
}

export { addPreviewAccessControl };
