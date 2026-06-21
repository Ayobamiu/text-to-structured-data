/**
 * Persist post-processing side effects (rows destined for side tables).
 *
 * Shared by the backfill path (applyToFiles.ts, operating over stored records)
 * and the auto-run pipeline stage (PostProcessingServicesStage.ts, operating
 * over a freshly-extracted file). Upserts by primary key so re-runs never
 * duplicate; throws on an unknown table so a misconfigured service fails loudly.
 */

import type { SideEffect } from './types.ts';

/** A pg client or pool — only query() is used here. */
export interface Queryable {
    query: (text: string, params?: unknown[]) => Promise<unknown>;
}

const RECORD_GEOCODE_COLS = [
    'section_result_id', 'file_id', 'slug', 'latitude', 'longitude',
    'precision_tier', 'strategy', 'provider', 'provider_location_type',
    'source_query', 'confidence', 'needs_review', 'raw_response', 'geocoder_version',
    // geocoder-derived address parts (don't waste the Google response)
    'geocoded_county', 'geocoded_township', 'geocoded_city', 'geocoded_state',
    'geocoded_postal_code', 'formatted_address',
];

export async function persistSideEffects(client: Queryable, sideEffects: SideEffect[]): Promise<void> {
    if (!sideEffects || sideEffects.length === 0) return;
    for (const se of sideEffects) {
        if (se.table === 'record_geocodes') {
            const row = se.row as Record<string, unknown>;
            // A geocode row keyed on section_result_id is the conflict target; skip
            // rows that lack it (e.g. a V1 single-record result) rather than fail.
            if (!row.section_result_id) continue;
            const vals = RECORD_GEOCODE_COLS.map((c) =>
                c === 'raw_response' && row[c] !== undefined && row[c] !== null
                    ? JSON.stringify(row[c]) : (row[c] ?? null));
            const placeholders = RECORD_GEOCODE_COLS.map((_, i) => `$${i + 1}`).join(', ');
            const updates = RECORD_GEOCODE_COLS.filter((c) => c !== 'section_result_id')
                .map((c) => `${c} = EXCLUDED.${c}`).join(', ');
            await client.query(
                `INSERT INTO record_geocodes (${RECORD_GEOCODE_COLS.join(', ')})
                 VALUES (${placeholders})
                 ON CONFLICT (section_result_id) DO UPDATE SET ${updates}, geocoded_at = NOW()`,
                vals,
            );
        } else if (se.table === 'plss_section_centroids') {
            const r = se.row as Record<string, unknown>;
            await client.query(
                `INSERT INTO plss_section_centroids (town, range, section, latitude, longitude, n_wells, source)
                 VALUES ($1,$2,$3,$4,$5,$6,$7)
                 ON CONFLICT (town, range, section) DO UPDATE SET
                   latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude,
                   n_wells = EXCLUDED.n_wells, source = EXCLUDED.source, computed_at = NOW()`,
                [r.town, r.range, r.section, r.latitude ?? null, r.longitude ?? null, r.n_wells ?? null, r.source ?? 'wellogic'],
            );
        } else {
            throw new Error(`persistSideEffects: no handler for table "${se.table}"`);
        }
    }
}

export default { persistSideEffects };
