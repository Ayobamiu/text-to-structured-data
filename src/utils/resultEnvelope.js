/**
 * V1/V2 result envelope helpers.
 *
 * V1 (legacy): job_files.result is a flat object of extracted fields:
 *     { permit_number: "17378", county: "Allegan", formations: [...], ... }
 *
 * V2 (per-section): job_files.result is an envelope keyed by slug:
 *     { mgs_well_log: [ { section_result_id: "...", permit_number: "17378", ... } ] }
 *
 * Many downstream consumers (pipeline stages, constraints, previews) were
 * written for V1 and access `result.county` directly. Rather than rewrite
 * every consumer, these helpers let them work transparently with both formats.
 *
 * Detection heuristic: a V2 envelope has top-level values that are ALL arrays
 * of objects (the slug→records shape). A V1 result has scalar/array fields
 * that match schema properties (county is a string, formations is an array
 * of formation objects, etc). We check: does every top-level value satisfy
 * Array.isArray AND contain at least one object with `section_result_id`?
 * If yes → V2. Otherwise → V1.
 */

/**
 * Returns true if `result` looks like a V2 per-section envelope.
 *
 * A V2 envelope has shape: { slug: [ { section_result_id, ...fields } ] }
 * Every top-level key maps to an array of record objects.
 */
export function isV2Envelope(result) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) return false;

    const keys = Object.keys(result);
    if (keys.length === 0) return false;

    // Check if ANY top-level value is an array containing an object with section_result_id.
    // This is the definitive signal — V1 results never have section_result_id.
    for (const key of keys) {
        const val = result[key];
        if (Array.isArray(val) && val.length > 0 && val[0] && typeof val[0] === 'object' && val[0].section_result_id) {
            return true;
        }
    }

    return false;
}

/**
 * Flatten a V2 envelope into a list of { slug, index, record } tuples.
 * For V1 results, returns a single entry with slug=null.
 *
 * @param {Object} result - V1 flat result or V2 envelope
 * @returns {{ isV2: boolean, records: Array<{ slug: string|null, index: number, record: Object }> }}
 */
export function flattenRecords(result) {
    if (!isV2Envelope(result)) {
        return { isV2: false, records: [{ slug: null, index: 0, record: result }] };
    }

    const records = [];
    for (const [slug, arr] of Object.entries(result)) {
        if (!Array.isArray(arr)) continue;
        for (let i = 0; i < arr.length; i++) {
            if (arr[i] && typeof arr[i] === 'object') {
                records.push({ slug, index: i, record: arr[i] });
            }
        }
    }
    return { isV2: true, records };
}

/**
 * Apply a transform function to every record in a result, regardless of
 * whether it's V1 or V2. Returns a new result with the same shape.
 *
 * For V1: transform(record) → new flat result.
 * For V2: transform(record) → each array entry is replaced.
 *
 * The transform receives (record, slug, index) and must return a new record.
 *
 * @param {Object} result
 * @param {(record: Object, slug: string|null, index: number) => Object} transformFn
 * @returns {Object} new result (same V1/V2 shape as input)
 */
export function mapRecords(result, transformFn) {
    if (!isV2Envelope(result)) {
        return transformFn(result, null, 0);
    }

    const newResult = {};
    for (const [slug, arr] of Object.entries(result)) {
        if (!Array.isArray(arr)) {
            // Shouldn't happen in a clean V2 envelope, but preserve it
            newResult[slug] = arr;
            continue;
        }
        newResult[slug] = arr.map((record, i) => {
            if (record && typeof record === 'object') {
                return transformFn(record, slug, i);
            }
            return record;
        });
    }
    return newResult;
}

/**
 * Read a field from the first record, whether V1 or V2.
 * Useful for single-value lookups like permit_number or county.
 *
 * For V1: returns result[fieldName]
 * For V2: returns the field from the first record in the first slug array.
 *
 * @param {Object} result
 * @param {string} fieldName
 * @returns {*} the field value, or undefined
 */
export function readField(result, fieldName) {
    if (!isV2Envelope(result)) {
        return result?.[fieldName];
    }

    // Return from the first record found
    for (const arr of Object.values(result)) {
        if (Array.isArray(arr) && arr.length > 0 && arr[0] && typeof arr[0] === 'object') {
            return arr[0][fieldName];
        }
    }
    return undefined;
}

/**
 * Get the first record as a flat object (for functions that need V1 shape).
 * For V1: returns the result as-is.
 * For V2: returns the first record from the first slug, WITHOUT section_result_id.
 *
 * @param {Object} result
 * @returns {Object} flat record
 */
export function getFirstRecord(result) {
    if (!isV2Envelope(result)) return result;

    for (const arr of Object.values(result)) {
        if (Array.isArray(arr) && arr.length > 0 && arr[0] && typeof arr[0] === 'object') {
            return arr[0];
        }
    }
    return result;
}

export default {
    isV2Envelope,
    flattenRecords,
    mapRecords,
    readField,
    getFirstRecord,
};
