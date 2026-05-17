#!/usr/bin/env node
/**
 * Migrate job processing_config away from legacy FLASK_URL extractors (mineru, documentai)
 * and jobs missing extraction.method (worker previously defaulted those to mineru).
 *
 * Run from ai/ with DATABASE_URL set:
 *   node migrations/migrate_extraction_to_paddleocr.js
 *
 * Dry-run (no writes):
 *   DRY_RUN=1 node migrations/migrate_extraction_to_paddleocr.js
 */

import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;
const dryRun = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

const pool = new Pool({
    connectionString:
        process.env.DATABASE_URL ||
        `postgresql://${process.env.DB_USER || 'postgres'}:${process.env.DB_PASSWORD || 'password'}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 5432}/${process.env.DB_NAME || 'batch_processor'}`,
    family: 4,
});

const AUDIT_QUERY = `
    SELECT
        id,
        name,
        COALESCE(processing_config->'extraction'->>'method', '(missing)') AS extraction_method
    FROM jobs
    WHERE processing_config->'extraction' IS NULL
       OR processing_config->'extraction'->>'method' IS NULL
       OR processing_config->'extraction'->>'method' IN ('mineru', 'documentai')
    ORDER BY created_at DESC
`;

const MIGRATE_QUERY = `
    UPDATE jobs
    SET
        processing_config = jsonb_set(
            processing_config,
            '{extraction}',
            jsonb_build_object(
                'method', 'paddleocr',
                'options', COALESCE(processing_config->'extraction'->'options', '{}'::jsonb)
            ),
            true
        ),
        updated_at = NOW()
    WHERE processing_config->'extraction' IS NULL
       OR processing_config->'extraction'->>'method' IS NULL
       OR processing_config->'extraction'->>'method' IN ('mineru', 'documentai')
    RETURNING id, name, processing_config->'extraction'->>'method' AS new_method
`;

async function main() {
    const client = await pool.connect();
    try {
        console.log(dryRun ? '🔍 DRY RUN — no rows will be updated\n' : '🔄 Migrating job extraction methods to paddleocr\n');

        const audit = await client.query(AUDIT_QUERY);
        console.log(`Jobs to update: ${audit.rowCount}`);
        for (const row of audit.rows) {
            console.log(`  - ${row.id}  ${row.name || '(unnamed)'}  method=${row.extraction_method}`);
        }

        if (audit.rowCount === 0) {
            console.log('\n✅ Nothing to migrate.');
            return;
        }

        if (dryRun) {
            console.log('\nRun without DRY_RUN=1 to apply.');
            return;
        }

        const result = await client.query(MIGRATE_QUERY);
        console.log(`\n✅ Updated ${result.rowCount} job(s).`);
        for (const row of result.rows) {
            console.log(`  - ${row.id}  ${row.name || '(unnamed)'}  → ${row.new_method}`);
        }
    } finally {
        client.release();
        await pool.end();
    }
}

main().catch((err) => {
    console.error('❌ Migration failed:', err);
    process.exit(1);
});
