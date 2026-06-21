/**
 * Migration: document_types.post_processing_defaults (Phase 2, post-processing auto-run).
 *
 * Adds a per-document-type list of post-processing services that run AUTOMATICALLY
 * during file processing, unless a job overrides them. This is the "slug default"
 * half of the activation model (the other half is per-job
 * `processing_config.postProcessing`; the job entry overrides the slug default).
 *
 * Shape (documented; not enforced by Postgres):
 *   [
 *     { "name": "geocode_locations", "enabled": true, "options": {} },
 *     ...
 *   ]
 *
 * Resolution at processing time (see src/services/postProcessing/resolvePostProcessing.ts):
 *   enabled = jobOverride.enabled ?? slugDefault.enabled ?? false
 *   options = { ...slugDefault.options, ...jobOverride.options }
 *   AND service.appliesTo(slug) must be true.
 *
 * Seeds `borehole_log` with geocode_locations enabled (locked decision 2026-06-21:
 * auto-geocode all borehole_log by default; toggleable per job).
 *
 * Idempotent (IF NOT EXISTS + conditional seed). Run: `npx tsx migrations/add_post_processing_to_document_types.ts`.
 */

import pool from '../src/database.js';

export default async function addPostProcessingDefaults(): Promise<void> {
    const client = await pool.connect();
    try {
        console.log('🔄 Adding post_processing_defaults column to document_types...');
        await client.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'document_types' AND column_name = 'post_processing_defaults'
                ) THEN
                    ALTER TABLE document_types
                    ADD COLUMN post_processing_defaults JSONB NOT NULL DEFAULT '[]'::jsonb;
                    COMMENT ON COLUMN document_types.post_processing_defaults IS
                        'Per-type post-processing services that auto-run during processing unless a job overrides them. Array of {name, enabled, options}. See ai/migrations/add_post_processing_to_document_types.ts.';
                ELSE
                    RAISE NOTICE 'document_types.post_processing_defaults already exists';
                END IF;
            END $$
        `);

        // Seed: auto-geocode borehole_log by default (locked 2026-06-21). Only seed
        // when the type exists and hasn't already been configured, so re-runs and
        // manual edits are preserved.
        const seedRes = await client.query(
            `UPDATE document_types
                SET post_processing_defaults = '[{"name":"geocode_locations","enabled":true,"options":{}}]'::jsonb
              WHERE slug = 'borehole_log'
                AND (post_processing_defaults IS NULL OR post_processing_defaults = '[]'::jsonb)
              RETURNING slug`,
        );
        if (seedRes.rows.length > 0) {
            console.log(`✅ Seeded geocode_locations default for: ${seedRes.rows.map((r) => r.slug).join(', ')}`);
        } else {
            console.log('ℹ️  borehole_log not found or already configured — no seed applied');
        }

        console.log('🎉 Migration complete');
    } finally {
        client.release();
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    addPostProcessingDefaults()
        .then(() => { console.log('Done'); process.exit(0); })
        .catch((e) => { console.error('💥 Migration failed:', e); process.exit(1); });
}
