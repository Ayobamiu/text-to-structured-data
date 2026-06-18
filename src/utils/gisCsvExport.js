/**
 * GIS-ready CSV export helpers (Phase 1 — attribute table).
 *
 * Turns a list of extracted records (one document_type / slug) into a flat,
 * one-row-per-record CSV that a hydrogeologist can load straight into ArcGIS
 * and join to an authoritative well-location source by `well_id` — no manual
 * cleanup. See GIS_EXPORT_HANDOFF.md for the full rationale.
 *
 * Flattening rules (intentionally simple for the attribute table):
 *   - Scalars (string/number/boolean) → one column.
 *   - One level of nested objects → each leaf scalar becomes its own column,
 *     named by the leaf key (e.g. site_identification.boring_well_id → well_id /
 *     boring_well_id). On a name collision the parent is prefixed.
 *   - Arrays are EXCLUDED here (one-to-many → phase-2 related tables).
 *   - Nested values that are themselves objects/arrays are skipped (we don't
 *     descend a second level — no `[object Object]`, no JSON blobs).
 *   - `section_result_id` is dropped (internal plumbing, not data).
 *
 * Headers are GIS-safe: lower snake_case, no spaces. `well_id` is always the
 * first column and is derived from `boring_well_id` when present.
 */

/** Lower snake_case, alphanumeric + underscore only — ArcGIS/shapefile-friendly. */
export function sanitizeHeader(key) {
    return String(key)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .replace(/_+/g, '_');
}

function scalarToString(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    return String(value);
}

function isScalar(v) {
    return v === null || v === undefined || typeof v !== 'object';
}

/**
 * Flatten one record to a { column: stringValue } map per the rules above.
 * @param {Object} record
 * @returns {Object<string,string>}
 */
export function flattenRecordForGis(record) {
    const flat = {};
    if (!record || typeof record !== 'object') return flat;

    for (const [key, value] of Object.entries(record)) {
        if (key === 'section_result_id') continue;

        if (Array.isArray(value)) continue; // phase-2 related tables

        if (value && typeof value === 'object') {
            // One level deep: leaf scalars become top-level columns.
            for (const [leafKey, leafVal] of Object.entries(value)) {
                if (!isScalar(leafVal)) continue; // don't descend further
                const col = sanitizeHeader(leafKey);
                if (!col) continue;
                if (Object.prototype.hasOwnProperty.call(flat, col)) {
                    // Collision across two nested objects — disambiguate with parent.
                    flat[sanitizeHeader(`${key}_${leafKey}`)] = scalarToString(leafVal);
                } else {
                    flat[col] = scalarToString(leafVal);
                }
            }
            continue;
        }

        const col = sanitizeHeader(key);
        if (col) flat[col] = scalarToString(value);
    }

    // well_id is the join key Omar cares about most — guarantee it exists.
    if (!Object.prototype.hasOwnProperty.call(flat, 'well_id') &&
        Object.prototype.hasOwnProperty.call(flat, 'boring_well_id')) {
        flat['well_id'] = flat['boring_well_id'];
    }

    return flat;
}

/**
 * Derive a column order from a json_schema's properties (best-effort): scalar
 * props by their key, object props by their leaf keys. Used to give the CSV a
 * stable, document-meaningful column order instead of insertion order.
 */
function deriveSchemaColumnOrder(schema) {
    const order = [];
    const props = schema && schema.properties;
    if (!props || typeof props !== 'object') return order;
    for (const [key, def] of Object.entries(props)) {
        const type = def && def.type;
        if (type === 'array') continue;
        if (def && def.properties && typeof def.properties === 'object') {
            for (const leafKey of Object.keys(def.properties)) {
                order.push(sanitizeHeader(leafKey));
            }
        } else {
            order.push(sanitizeHeader(key));
        }
    }
    return order;
}

// Location / identity columns Omar joins on — surfaced first when present.
const PREFERRED_LEADING = [
    'well_id', 'boring_well_id', 'boring_well_id_full', 'site_name',
    'state', 'county', 'township', 'range', 'section',
    'latitude_dd', 'longitude_dd', 'northing_ft', 'easting_ft',
    'coordinate_datum', 'ground_elevation_ft', 'elevation_datum', 'toc_elevation_ft',
];

/**
 * Build the ordered column list across all flattened records: well_id first,
 * then known location/identity fields, then schema order, then anything else
 * alphabetically. Only columns actually observed in the data are emitted.
 *
 * @param {Array<Object>} flatRecords
 * @param {Object|null} schema  json_schema for the slug (optional)
 * @returns {string[]}
 */
export function buildColumns(flatRecords, schema = null) {
    const observed = new Set();
    for (const fr of flatRecords) {
        for (const k of Object.keys(fr)) observed.add(k);
    }

    const ordered = [];
    const pushIf = (c) => {
        if (observed.has(c) && !ordered.includes(c)) ordered.push(c);
    };

    pushIf('well_id');
    for (const c of PREFERRED_LEADING) pushIf(c);
    for (const c of deriveSchemaColumnOrder(schema)) pushIf(c);
    for (const c of [...observed].sort()) pushIf(c);

    return ordered;
}

/** Escape one CSV field per RFC 4180. */
export function csvEscapeField(value) {
    const s = value === null || value === undefined ? '' : String(value);
    if (/[",\n\r]/.test(s)) {
        return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
}

/**
 * Stream the records as CSV to an Express response. Writes the header then one
 * line per record so we never build the whole CSV string in memory.
 *
 * @param {import('express').Response} res
 * @param {Array<Object>} records   raw record objects (one slug)
 * @param {Object|null} schema      json_schema for column ordering (optional)
 */
export function streamRecordsAsCsv(res, records, schema = null) {
    const flat = records.map(flattenRecordForGis);
    const columns = buildColumns(flat, schema);

    res.write(columns.map(csvEscapeField).join(',') + '\r\n');
    for (const fr of flat) {
        res.write(columns.map((c) => csvEscapeField(fr[c] ?? '')).join(',') + '\r\n');
    }
    res.end();
}

export default {
    sanitizeHeader,
    flattenRecordForGis,
    buildColumns,
    csvEscapeField,
    streamRecordsAsCsv,
};
