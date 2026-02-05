#!/usr/bin/env node
/**
 * Database Migration: Add queue_control table + queue timing columns
 * Adds:
 *  - queue_control table (pause/resume)
 *  - available_at and processing_started_at columns on file_processing_queue
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
    connectionString: process.env.DATABASE_URL || `postgresql://${process.env.DB_USER || 'postgres'}:${process.env.DB_PASSWORD || 'password'}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 5432}/${process.env.DB_NAME || 'batch_processor'}`,
    family: 4,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

async function addQueueControlAndColumns() {
    const client = await pool.connect();
    try {
        console.log('🔄 Adding queue_control table and queue timing columns...');

        const tableCheck = await client.query(`SELECT to_regclass('public.file_processing_queue') AS name`);
        if (!tableCheck.rows[0]?.name) {
            throw new Error('file_processing_queue table not found. Create it before running this migration.');
        }

        await client.query(`
            ALTER TABLE file_processing_queue
            ADD COLUMN IF NOT EXISTS available_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        `);

        await client.query(`
            ALTER TABLE file_processing_queue
            ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ
        `);

        await client.query(`
            UPDATE file_processing_queue
            SET available_at = COALESCE(available_at, updated_at, created_at, NOW())
            WHERE available_at IS NULL
        `);

        const queueControlTable = await client.query(`SELECT to_regclass('public.queue_control') AS name`);
        if (!queueControlTable.rows[0]?.name) {
            await client.query(`
                CREATE TABLE queue_control (
                    id INTEGER PRIMARY KEY DEFAULT 1,
                    paused BOOLEAN NOT NULL DEFAULT false,
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            `);
        }

        const queueControlColumns = await client.query(`
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'queue_control'
        `);
        const columns = queueControlColumns.rows.map(row => row.column_name);
        const hasKeyColumn = columns.includes('key');

        if (hasKeyColumn) {
            if (!columns.includes('paused')) {
                await client.query(`ALTER TABLE queue_control ADD COLUMN paused BOOLEAN NOT NULL DEFAULT false`);
            }

            if (!columns.includes('updated_at')) {
                await client.query(`ALTER TABLE queue_control ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
            }

            const existingControl = await client.query(`SELECT 1 FROM queue_control WHERE key = 'queue' LIMIT 1`);
            if (existingControl.rows.length === 0) {
                await client.query(`
                    INSERT INTO queue_control (key, paused, updated_at)
                    VALUES ('queue', false, NOW())
                `);
            }
        } else {
            if (!columns.includes('id')) {
                await client.query(`ALTER TABLE queue_control ADD COLUMN id INTEGER`);
                await client.query(`UPDATE queue_control SET id = 1 WHERE id IS NULL`);

                const rowCountResult = await client.query(`SELECT COUNT(*)::int AS count FROM queue_control`);
                if (rowCountResult.rows[0].count > 1) {
                    await client.query(`
                        DELETE FROM queue_control
                        WHERE ctid NOT IN (
                            SELECT ctid FROM queue_control
                            ORDER BY updated_at DESC NULLS LAST
                            LIMIT 1
                        )
                    `);
                }
            }

            if (!columns.includes('paused')) {
                await client.query(`ALTER TABLE queue_control ADD COLUMN paused BOOLEAN NOT NULL DEFAULT false`);
            }

            if (!columns.includes('updated_at')) {
                await client.query(`ALTER TABLE queue_control ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
            }

            const hasPrimaryKey = await client.query(`
                SELECT 1
                FROM pg_constraint
                WHERE conrelid = 'public.queue_control'::regclass
                  AND contype = 'p'
                LIMIT 1
            `);
            if (hasPrimaryKey.rows.length === 0) {
                const rowCountResult = await client.query(`SELECT COUNT(*)::int AS count FROM queue_control`);
                if (rowCountResult.rows[0].count > 1) {
                    await client.query(`
                        DELETE FROM queue_control
                        WHERE ctid NOT IN (
                            SELECT ctid FROM queue_control
                            ORDER BY updated_at DESC NULLS LAST
                            LIMIT 1
                        )
                    `);
                }
                await client.query(`ALTER TABLE queue_control ADD PRIMARY KEY (id)`);
            }

            const existingControl = await client.query(`SELECT 1 FROM queue_control WHERE id = 1 LIMIT 1`);
            if (existingControl.rows.length === 0) {
                await client.query(`
                    INSERT INTO queue_control (id, paused, updated_at)
                    VALUES (1, false, NOW())
                `);
            }
        }

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_fpq_status ON file_processing_queue(status)
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_fpq_available_at ON file_processing_queue(available_at)
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_fpq_priority_created ON file_processing_queue(priority, created_at)
        `);

        console.log('✅ Queue control + columns migration complete');
    } catch (error) {
        console.error('❌ Error adding queue control + columns:', error.message);
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    addQueueControlAndColumns()
        .then(() => {
            console.log('🎉 Migration completed successfully!');
            process.exit(0);
        })
        .catch((error) => {
            console.error('💥 Migration failed:', error);
            process.exit(1);
        });
}

export { addQueueControlAndColumns };
