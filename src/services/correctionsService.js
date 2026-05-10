/**
 * Field Corrections Service (Phase 0)
 *
 * Diffs an original extracted result against a reviewer-corrected result and
 * writes one row per leaf-value change to field_corrections.
 *
 * Used as fire-and-forget from PUT /files/:id/results — corrections logging
 * never blocks the response, and a logging failure never fails the user's
 * save. The corrections table is foundational for future few-shot pools and
 * fine-tuning data; we want to start capturing it on day one even though we
 * don't read it back yet.
 *
 * Diff semantics (intentionally simple for v1):
 *   - Recursive walk of both trees in parallel.
 *   - Leaf comparison uses JSON.stringify-equality (handles primitives,
 *     null, and structurally-equal nested values where both sides have
 *     "moved" together — we only descend into objects/arrays to find
 *     genuine value changes).
 *   - Object key added on the corrected side  → change_kind='added'
 *   - Object key removed on the corrected side → change_kind='removed'
 *   - Same key, different leaf value           → change_kind='modified'
 *   - Arrays are diffed positionally. An item inserted in the middle of a
 *     long array will register as N modifications + one add — known limitation,
 *     fine for v1 since reviewers mostly edit leaf values, not reorder rows.
 *
 * Path notation matches the v1 (today's flat result) and the future v2
 * (typed-section envelope) shapes:
 *   - 'well_construction.casing_diameter'
 *   - 'sections.boring_log[0].lithology_intervals[3].primary_material'
 */

import pool from '../database.js';

const MAX_VALUE_BYTES = 64 * 1024; // 64 KB per logged value — guard against giant blobs

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function safeStringify(v) {
    try {
        return JSON.stringify(v);
    } catch {
        return undefined;
    }
}

function leafEqual(a, b) {
    const sa = safeStringify(a);
    const sb = safeStringify(b);
    return sa === sb;
}

function truncateForStorage(value) {
    // Postgres JSONB has a hard 268MB limit per value but we never want to
    // log anything close to that. Drop oversized values to a placeholder so
    // we still record the path + change happened, just not the payload.
    const s = safeStringify(value);
    if (s === undefined) return null;
    if (s.length > MAX_VALUE_BYTES) {
        return { __truncated: true, originalByteLength: s.length };
    }
    return value;
}

function joinPath(prefix, key) {
    if (prefix === '') return String(key);
    if (typeof key === 'number') return `${prefix}[${key}]`;
    return `${prefix}.${key}`;
}

/**
 * Walk two trees in parallel; emit a row per change.
 * @param {*} original
 * @param {*} corrected
 * @param {string} path
 * @param {Array} out
 */
function walk(original, corrected, path, out) {
    if (leafEqual(original, corrected)) return;

    // Both objects? Diff key-by-key.
    if (isPlainObject(original) && isPlainObject(corrected)) {
        const keys = new Set([...Object.keys(original), ...Object.keys(corrected)]);
        for (const k of keys) {
            const inO = Object.prototype.hasOwnProperty.call(original, k);
            const inC = Object.prototype.hasOwnProperty.call(corrected, k);
            if (inO && inC) {
                walk(original[k], corrected[k], joinPath(path, k), out);
            } else if (!inO && inC) {
                out.push({
                    json_path: joinPath(path, k),
                    change_kind: 'added',
                    original_value: null,
                    corrected_value: truncateForStorage(corrected[k]),
                });
            } else {
                out.push({
                    json_path: joinPath(path, k),
                    change_kind: 'removed',
                    original_value: truncateForStorage(original[k]),
                    corrected_value: null,
                });
            }
        }
        return;
    }

    // Both arrays? Diff positionally.
    if (Array.isArray(original) && Array.isArray(corrected)) {
        const len = Math.max(original.length, corrected.length);
        for (let i = 0; i < len; i++) {
            const hasO = i < original.length;
            const hasC = i < corrected.length;
            if (hasO && hasC) {
                walk(original[i], corrected[i], joinPath(path, i), out);
            } else if (!hasO && hasC) {
                out.push({
                    json_path: joinPath(path, i),
                    change_kind: 'added',
                    original_value: null,
                    corrected_value: truncateForStorage(corrected[i]),
                });
            } else {
                out.push({
                    json_path: joinPath(path, i),
                    change_kind: 'removed',
                    original_value: truncateForStorage(original[i]),
                    corrected_value: null,
                });
            }
        }
        return;
    }

    // Type mismatch or two non-equal leaves: one modification at this path.
    out.push({
        json_path: path || '$',
        change_kind: 'modified',
        original_value: truncateForStorage(original),
        corrected_value: truncateForStorage(corrected),
    });
}

/**
 * Compute the diff between two result objects.
 * @returns {Array<{json_path, change_kind, original_value, corrected_value}>}
 */
export function diffResults(original, corrected) {
    const out = [];
    walk(original, corrected, '', out);
    return out;
}

/**
 * Detect document_type_slug + section_index from a json_path, when the path
 * is in the v2 envelope shape: 'sections.<slug>[<i>].<rest>'.
 *
 * Returns { documentTypeSlug, sectionIndex, sectionType } or all-null when
 * the path doesn't match. v1 (today's flat result) paths return all-null,
 * and the document_type for those rows is whatever the caller supplies.
 */
function parseSectionContext(jsonPath) {
    // Match e.g. sections.boring_log[0]....
    const m = /^sections\.([a-z0-9_]+)\[(\d+)\]/i.exec(jsonPath);
    if (!m) return { documentTypeSlug: null, sectionIndex: null, sectionType: null };
    return {
        documentTypeSlug: m[1],
        sectionType: m[1],
        sectionIndex: Number(m[2]),
    };
}

/**
 * Persist the corrections produced by diffResults into field_corrections.
 *
 * @param {Object} args
 * @param {string} args.fileId
 * @param {string} [args.jobId]
 * @param {string} [args.organizationId]
 * @param {string} [args.correctedBy]                User UUID
 * @param {*} args.originalResult                    The result blob before edit
 * @param {*} args.correctedResult                   The result blob after edit
 * @param {string} [args.documentTypeSlugFallback]   Used when path doesn't match v2 sections.<slug>[i] (i.e. v1 flat results)
 * @param {number} [args.schemaVersion]              Schema version under which the original extraction ran
 *
 * @returns {Promise<{ written: number, skipped: number }>}
 */
export async function recordCorrections({
    fileId,
    jobId = null,
    organizationId = null,
    correctedBy = null,
    originalResult,
    correctedResult,
    documentTypeSlugFallback = null,
    schemaVersion = null,
}) {
    if (!fileId) throw new Error('recordCorrections requires fileId');

    // Treat null/undefined originalResult as empty object so first-ever
    // saves still record what was added (rather than logging nothing).
    const safeOriginal = originalResult == null ? {} : originalResult;
    const safeCorrected = correctedResult == null ? {} : correctedResult;

    const changes = diffResults(safeOriginal, safeCorrected);
    if (changes.length === 0) {
        return { written: 0, skipped: 0 };
    }

    const client = await pool.connect();
    try {
        // Single multi-row INSERT — keeps a save with hundreds of changes
        // (e.g. fixing a long table) cheap.
        const valuesSql = [];
        const params = [];
        let p = 1;
        let written = 0;
        for (const change of changes) {
            const ctx = parseSectionContext(change.json_path);
            const documentTypeSlug =
                ctx.documentTypeSlug || documentTypeSlugFallback || null;

            params.push(
                fileId,
                jobId,
                documentTypeSlug,
                schemaVersion,
                ctx.sectionType,
                ctx.sectionIndex,
                change.json_path,
                change.change_kind,
                change.original_value === null ? null : JSON.stringify(change.original_value),
                change.corrected_value === null ? null : JSON.stringify(change.corrected_value),
                correctedBy,
                organizationId
            );

            const ph = (n) => `$${p + n - 1}`;
            valuesSql.push(
                `(${ph(1)}, ${ph(2)}, ${ph(3)}, ${ph(4)}, ${ph(5)}, ${ph(6)}, ${ph(7)}, ${ph(8)}, ${ph(9)}, ${ph(10)}, ${ph(11)}, ${ph(12)})`
            );
            p += 12;
            written++;
        }

        await client.query(
            `INSERT INTO field_corrections
                (file_id, job_id, document_type_slug, schema_version,
                 section_type, section_index, json_path, change_kind,
                 original_value, corrected_value, corrected_by, organization_id)
             VALUES ${valuesSql.join(', ')}`,
            params
        );

        return { written, skipped: changes.length - written };
    } finally {
        client.release();
    }
}

export default {
    diffResults,
    recordCorrections,
};
