/**
 * Migration: record_geocodes + plss_section_centroids (Phase 2, D2).
 *
 * record_geocodes is the canonical spatial layer — derived, fallible coordinates
 * kept SEPARATE from the extracted record (which stays ground truth). One row per
 * record (keyed by section_result_id), carrying coordinates + a precision tier +
 * full provenance. plss_section_centroids caches section centroids derived from
 * Michigan Wellogic so we hit ArcGIS once per distinct section, not per record.
 *
 * Idempotent (CREATE ... IF NOT EXISTS). Run: `npx tsx migrations/add_record_geocodes.ts`.
 */

import pool from '../src/database.js';

export default async function addRecordGeocodes(): Promise<void> {
    const client = await pool.connect();
    try {
        console.log('Creating record_geocodes + plss_section_centroids...');

        await client.query(`
            CREATE TABLE IF NOT EXISTS record_geocodes (
                section_result_id      TEXT PRIMARY KEY,
                file_id                UUID,
                slug                   TEXT,
                latitude               DOUBLE PRECISION,
                longitude              DOUBLE PRECISION,
                precision_tier         TEXT,   -- exact | good | approx | plss_centroid | unresolved
                strategy               TEXT,   -- document | address_rooftop | address_interp | plss_centroid | none
                provider               TEXT,   -- document | google | wellogic_plss
                provider_location_type TEXT,   -- e.g. ROOFTOP, RANGE_INTERPOLATED
                source_query           TEXT,
                confidence             NUMERIC,
                needs_review           BOOLEAN NOT NULL DEFAULT false,
                raw_response           JSONB,
                geocoder_version       TEXT,
                geocoded_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_record_geocodes_file ON record_geocodes (file_id)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_record_geocodes_slug ON record_geocodes (slug)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_record_geocodes_precision ON record_geocodes (precision_tier)`);

        await client.query(`
            CREATE TABLE IF NOT EXISTS plss_section_centroids (
                town        TEXT NOT NULL,
                range       TEXT NOT NULL,
                section     INTEGER NOT NULL,
                latitude    DOUBLE PRECISION,
                longitude   DOUBLE PRECISION,
                n_wells     INTEGER,
                source      TEXT NOT NULL DEFAULT 'wellogic',
                computed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (town, range, section)
            )
        `);

        console.log('✅ record_geocodes + plss_section_centroids ready');
    } finally {
        client.release();
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    addRecordGeocodes()
        .then(() => { console.log('🎉 Migration completed'); process.exit(0); })
        .catch((e) => { console.error('💥 Migration failed:', e); process.exit(1); });
}
