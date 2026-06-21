/**
 * Migration: geocoder-derived address parts on record_geocodes (Phase 2).
 *
 * We already store the full Google response in record_geocodes.raw_response, but
 * only surfaced lat/long — so a well could have coordinates yet an empty COUNTY/
 * TOWNSHIP. This adds typed columns for the county / civil township / city / state
 * / zip / formatted address and BACKFILLS them from the stored raw_response, with
 * ZERO new API calls. The extracted record is never touched (provenance stays in
 * record_geocodes); the Wellogic export reads these as fallbacks.
 *
 * Idempotent. Run: `npx tsx migrations/add_geocode_address_components.ts`.
 */

import pool from '../src/database.js';

export default async function addGeocodeAddressComponents(): Promise<void> {
    const client = await pool.connect();
    try {
        console.log('Adding geocoded_* columns to record_geocodes...');
        await client.query(`
            ALTER TABLE record_geocodes
                ADD COLUMN IF NOT EXISTS geocoded_county      TEXT,
                ADD COLUMN IF NOT EXISTS geocoded_township    TEXT,
                ADD COLUMN IF NOT EXISTS geocoded_city        TEXT,
                ADD COLUMN IF NOT EXISTS geocoded_state       TEXT,
                ADD COLUMN IF NOT EXISTS geocoded_postal_code TEXT,
                ADD COLUMN IF NOT EXISTS formatted_address    TEXT
        `);

        console.log('Backfilling from stored raw_response (no API calls)...');
        // Helper: first address_component whose types[] contains $type.
        const comp = (type: string, field = 'long_name') =>
            `(SELECT c->>'${field}' FROM jsonb_array_elements(raw_response->'address_components') c
              WHERE c->'types' ? '${type}' LIMIT 1)`;
        const res = await client.query(`
            UPDATE record_geocodes SET
                formatted_address    = raw_response->>'formatted_address',
                geocoded_county      = regexp_replace(${comp('administrative_area_level_2')}, '\\s+County$', ''),
                geocoded_township    = ${comp('administrative_area_level_3')},
                geocoded_city        = ${comp('locality')},
                geocoded_state       = ${comp('administrative_area_level_1', 'short_name')},
                geocoded_postal_code = ${comp('postal_code')}
            WHERE provider = 'google' AND raw_response ? 'address_components'
        `);
        console.log(`✅ Backfilled ${res.rowCount} geocoded rows`);
    } finally {
        client.release();
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    addGeocodeAddressComponents()
        .then(() => { console.log('🎉 Migration completed'); process.exit(0); })
        .catch((e) => { console.error('💥 Migration failed:', e); process.exit(1); });
}
