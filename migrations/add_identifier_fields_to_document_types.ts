/**
 * Migration: document_types.identifier_fields (preview record label).
 *
 * Adds a per-document-type, ordered list of dot-paths used to label a record in
 * the preview's left fixed "ID" column (and the record drawer header). Different
 * vendors put the identifier in different places — borehole_log carries it at
 * `site_identification.boring_well_id`, mgs_well_log at the root `well_number` —
 * so the choice is document-type-specific.
 *
 * Before this column the frontend guessed the identifier with a global heuristic
 * (a priority list of field names crossed with common container objects). That
 * still runs as the fallback for any type with no configured paths; a configured
 * type resolves exactly and unambiguously instead.
 *
 * Shape (documented; not enforced by Postgres) — an ORDERED array of dot-paths,
 * tried in order, first non-empty scalar wins (so you can list fallbacks):
 *   ["site_identification.boring_well_id", "boring_well_id"]
 *
 * Empty array → no per-type config (frontend falls back to the heuristic).
 *
 * Lives on document_types (not schemas): it describes the type generically and
 * doesn't change with each schema version — same rationale as classifier_hints /
 * post_processing_defaults.
 *
 * Idempotent (IF NOT EXISTS + conditional seed). Run:
 *   `npx tsx migrations/add_identifier_fields_to_document_types.ts`.
 */

import pool from '../src/database.js';

// Seed only the two types we know today; others stay '[]' (heuristic fallback).
const SEED: Record<string, string[]> = {
    borehole_log: ['site_identification.boring_well_id'],
    mgs_well_log: ['well_number'],
};

export default async function addIdentifierFields(): Promise<void> {
    const client = await pool.connect();
    try {
        console.log('🔄 Adding identifier_fields column to document_types...');
        await client.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'document_types' AND column_name = 'identifier_fields'
                ) THEN
                    ALTER TABLE document_types
                    ADD COLUMN identifier_fields JSONB NOT NULL DEFAULT '[]'::jsonb;
                    COMMENT ON COLUMN document_types.identifier_fields IS
                        'Per-type ordered list of dot-paths used to label a record in the preview ID column / drawer header. First non-empty scalar wins. See ai/migrations/add_identifier_fields_to_document_types.ts.';
                ELSE
                    RAISE NOTICE 'document_types.identifier_fields already exists';
                END IF;
            END $$
        `);

        // Seed known types. Only when the type exists and hasn't already been
        // configured, so re-runs and manual edits are preserved.
        for (const [slug, fields] of Object.entries(SEED)) {
            const res = await client.query(
                `UPDATE document_types
                    SET identifier_fields = $1::jsonb, updated_at = NOW()
                  WHERE slug = $2
                    AND (identifier_fields IS NULL OR identifier_fields = '[]'::jsonb)
                  RETURNING slug`,
                [JSON.stringify(fields), slug],
            );
            if (res.rows.length > 0) {
                console.log(`✅ Seeded identifier_fields for ${slug}: ${JSON.stringify(fields)}`);
            } else {
                console.log(`ℹ️  ${slug} not found or already configured — no seed applied`);
            }
        }

        console.log('🎉 Migration complete');
    } finally {
        client.release();
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    addIdentifierFields()
        .then(() => { console.log('Done'); process.exit(0); })
        .catch((e) => { console.error('💥 Migration failed:', e); process.exit(1); });
}
