/**
 * The promoted columns on extracted_records — the typed, indexed dimensions that
 * the compiler can filter directly (instead of data->>). Kept here so the catalog,
 * compiler, and any view generator agree on one list.
 */
import type { FieldType } from './types.ts';

export const PROMOTED_COLUMNS: Record<string, FieldType> = {
    latitude: 'number',
    longitude: 'number',
    county: 'string',
    state: 'string',
    event_date: 'date',
    depth_top: 'number',
    depth_bottom: 'number',
    record_label: 'string',
};

/**
 * Synonyms: common raw field names → the promoted column they map to. Lets the
 * translator emit either the natural field ("measured_depth", "completion_date")
 * or the promoted column; the compiler resolves both to the typed column.
 */
export const PROMOTED_SYNONYMS: Record<string, string> = {
    latitude_dd: 'latitude',
    surface_latitude: 'latitude',
    lat: 'latitude',
    longitude_dd: 'longitude',
    surface_longitude: 'longitude',
    lon: 'longitude',
    long: 'longitude',
    county_name: 'county',
    state_name: 'state',
    completion_date: 'event_date',
    log_date: 'event_date',
    sample_date: 'event_date',
    measured_depth: 'depth_bottom',
    true_depth: 'depth_bottom',
    total_depth: 'depth_bottom',
    well_total_depth: 'depth_bottom',
    bottom_depth: 'depth_bottom',
    top_depth: 'depth_top',
    api_number: 'record_label',
    permit_number: 'record_label',
    well_number: 'record_label',
};

/** Resolve a field name to a promoted column, or null if it isn't one. */
export function toPromotedColumn(field: string): string | null {
    const f = field.toLowerCase();
    if (f in PROMOTED_COLUMNS) return f;
    if (f in PROMOTED_SYNONYMS) return PROMOTED_SYNONYMS[f];
    return null;
}
