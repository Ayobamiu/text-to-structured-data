/**
 * The canonical gold-set field path, and the only place its shape is decided.
 *
 *   well_construction.screen_to_ft
 *   lithology_intervals[0].depth_from_ft
 *
 * Three independent things have to agree on this string or the whole feature
 * silently misaligns:
 *
 *   1. the seeder, writing gold_labels.field_path
 *   2. the review panel, deriving a path from the JSON tree node under the
 *      cursor (a seeded field whose path doesn't match renders as unseeded,
 *      so the reviewer sees no checklist and nothing looks broken)
 *   3. the scorer, which aggregates `lithology_intervals[3].depth_to_ft` under
 *      `lithology_intervals[].depth_to_ft` — without that, every row index
 *      becomes its own "field" with n=1 and no interval is computable
 *
 * The web repo carries a TypeScript twin of joinFieldPath/aggregateFieldPath;
 * both sides are pinned by tests against the same cases.
 *
 * Plain ESM rather than TypeScript on purpose: scripts/goldSet*.mjs run under
 * bare `node`, which cannot import .ts, and this module has to be reachable
 * from both those scripts and the TS service.
 */

/**
 * Build a canonical path from a key array. Numeric keys are array indices —
 * that is how react-json-view reports them, and it is the only signal we get
 * that a level is an array rather than an object with numeric-looking keys.
 *
 * @param {Array<string | number>} keys
 * @returns {string}
 */
export function joinFieldPath(keys) {
    let out = '';
    for (const key of keys ?? []) {
        if (typeof key === 'number' || /^\d+$/.test(String(key))) {
            out += `[${Number(key)}]`;
        } else {
            out += out ? `.${key}` : String(key);
        }
    }
    return out;
}

/**
 * Collapse array indices so every row of a table aggregates under one field.
 * `lithology_intervals[3].depth_to_ft` → `lithology_intervals[].depth_to_ft`
 *
 * @param {string} path
 * @returns {string}
 */
export function aggregateFieldPath(path) {
    return String(path ?? '').replace(/\[\d+\]/g, '[]');
}

/**
 * Split a canonical path into keys. Indices come back as numbers, so a
 * round-trip through joinFieldPath is lossless.
 *
 * @param {string} path
 * @returns {Array<string | number>}
 */
export function splitFieldPath(path) {
    const keys = [];
    const re = /([^.[\]]+)|\[(\d+)\]/g;
    let m;
    while ((m = re.exec(String(path ?? ''))) !== null) {
        keys.push(m[2] !== undefined ? Number(m[2]) : m[1]);
    }
    return keys;
}

/**
 * Read the value at a canonical path. Returns undefined for any missing link
 * in the chain — callers treat undefined and null alike (both are "blank",
 * which is a legitimate and often CORRECT extraction).
 *
 * @param {unknown} obj
 * @param {string} path
 * @returns {unknown}
 */
export function getAtFieldPath(obj, path) {
    let cur = obj;
    for (const key of splitFieldPath(path)) {
        if (cur == null) return undefined;
        cur = cur[key];
    }
    return cur;
}

/**
 * Paths of every seeded leaf at or beneath `path`.
 *
 * This is what makes "the whole well_construction block is right" one click:
 * it expands to a real verdict on each seeded leaf underneath, so the row
 * count — and therefore the denominator — is identical to judging them one at
 * a time. A single verdict stored against the container would collapse
 * several observations into one and could not be scored per field.
 *
 * The prefix test is deliberately `.`/`[`-anchored: `lithology_intervals` must
 * not swallow `lithology_intervals_notes`.
 *
 * @param {string} path
 * @param {Iterable<string>} seededPaths
 * @returns {string[]}
 */
export function seededLeavesUnder(path, seededPaths) {
    const out = [];
    for (const candidate of seededPaths) {
        if (
            path === '' ||
            candidate === path ||
            candidate.startsWith(`${path}.`) ||
            candidate.startsWith(`${path}[`)
        ) {
            out.push(candidate);
        }
    }
    return out.sort();
}

/**
 * The stored form of an extracted value: NULL means blank.
 *
 * Blank is not a defect — many fields are legitimately absent
 * (`screen_from_ft` is ~41% filled because most borings aren't wells), and
 * "blank in the extraction, blank on the page" is the single most-missed
 * CORRECT verdict. Objects and arrays are stringified so a reviewer judging a
 * whole node sees what was actually extracted.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function serializeExtractedValue(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'object') return JSON.stringify(value);
    const s = String(value);
    return s.trim() === '' ? null : s;
}
