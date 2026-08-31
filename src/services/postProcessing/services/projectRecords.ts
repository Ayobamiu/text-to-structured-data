/**
 * project_records — derive the queryable projection of a record into the
 * extracted_records table. The record itself stays untouched; this only emits
 * side-effect rows (like geocode_locations writes record_geocodes).
 *
 * Grain: one '_root' row (the record minus its array-of-object sections) plus
 * one row per element of each array section (lithology_intervals, samples, …).
 *
 * Promoted columns: record-level geo/identity (latitude, longitude, county,
 * state, record_label) are computed once and inherited by every row, so a filter
 * like "lithology intervals in Livingston County" works on any section. Per-row
 * dims (event_date, depth_top, depth_bottom) come from the row's own fields.
 * Everything else lives in `data` (queried as data->>'field').
 *
 * record_uid = section_result_id (V2) or file_id (V1 has no section_result_id),
 * giving a stable per-record key so the persister can delete-then-insert.
 */

import type { PostProcessingService, RunArgs, RunResult, SideEffect, RecordObject } from '../types.ts';

// 1.1.0: county promoted column is normalized (case + " County" suffix) so filters
// and GROUP BY collapse dirty variants. Bumped to re-project existing records.
export const PROJECTOR_VERSION = '1.1.0';

// Field-name candidates (lowercased) for each promoted dimension.
const LAT = ['latitude', 'latitude_dd', 'surface_latitude', 'lat'];
const LON = ['longitude', 'longitude_dd', 'surface_longitude', 'lon', 'long'];
const COUNTY = ['county', 'county_name'];
const STATE = ['state', 'state_name'];
const LABEL = ['api_number', 'permit_number', 'well_number', 'well_name', 'log_number'];
const DATES = ['completion_date', 'log_date', 'sample_date', 'completed_on', 'date'];
const DEPTH_BOTTOM = ['measured_depth', 'true_depth', 'total_depth', 'well_total_depth', 'bottom_depth', 'depth_bottom'];
const DEPTH_TOP = ['top_depth', 'depth_top'];

// Object sections we look inside when a dimension isn't at top level.
const NESTED = [
    'site_identification', 'document_metadata', 'well_construction',
    'drilling_and_personnel', 'project_information', 'site_and_location',
];

function lcKeys(obj: Record<string, unknown>): Map<string, unknown> {
    const m = new Map<string, unknown>();
    for (const [k, v] of Object.entries(obj)) m.set(k.toLowerCase(), v);
    return m;
}

const firstPresent = (m: Map<string, unknown>, cands: string[]): unknown => {
    for (const c of cands) {
        const v = m.get(c);
        if (v !== undefined && v !== null && v !== '') return v;
    }
    return null;
};

/** Find a dimension at top level, then one level into NESTED object sections. */
function findField(record: RecordObject, candidates: string[]): unknown {
    const top = lcKeys(record as Record<string, unknown>);
    const hit = firstPresent(top, candidates);
    if (hit !== null) return hit;
    for (const sect of NESTED) {
        const s = top.get(sect);
        if (s && typeof s === 'object' && !Array.isArray(s)) {
            const v = firstPresent(lcKeys(s as Record<string, unknown>), candidates);
            if (v !== null) return v;
        }
    }
    return null;
}

const toNum = (v: unknown): number | null => {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
};
const toStr = (v: unknown): string | null => {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    return s || null;
};

/**
 * Canonicalize a county so filters and GROUP BY collapse dirty variants:
 * "JACKSON" / "jackson" / "Jackson County" all become "Jackson".
 */
export function normalizeCounty(v: unknown): string | null {
    const s = toStr(v);
    if (!s) return null;
    const stripped = s.replace(/\s+county$/i, '').trim();
    if (!stripped) return null;
    return stripped.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/** Loose date → 'YYYY-MM-DD' | null. A bare year becomes Jan 1. */
export function toDate(v: unknown): string | null {
    const s = toStr(v);
    if (!s) return null;
    if (/^\d{4}$/.test(s)) return `${s}-01-01`;
    const t = Date.parse(s);
    if (Number.isNaN(t)) return null;
    return new Date(t).toISOString().slice(0, 10);
}

/** An array whose elements are all plain objects → becomes its own rows. */
function isArraySection(v: unknown): v is Record<string, unknown>[] {
    return Array.isArray(v) && v.length > 0 && v.every((e) => e !== null && typeof e === 'object' && !Array.isArray(e));
}

/** Record-level dims, inherited by every row of the record. */
function recordDims(record: RecordObject) {
    return {
        latitude: toNum(findField(record, LAT)),
        longitude: toNum(findField(record, LON)),
        county: normalizeCounty(findField(record, COUNTY)),
        state: toStr(findField(record, STATE)),
        record_label: toStr(findField(record, LABEL)),
    };
}

/** Per-row dims read from the row's own top-level fields. */
function rowDims(obj: Record<string, unknown>) {
    const m = lcKeys(obj);
    return {
        event_date: toDate(firstPresent(m, DATES)),
        depth_top: toNum(firstPresent(m, DEPTH_TOP)),
        depth_bottom: toNum(firstPresent(m, DEPTH_BOTTOM)),
    };
}

const projectRecords: PostProcessingService = {
    name: 'project_records',
    version: PROJECTOR_VERSION,
    appliesTo: () => true,

    async run({ record, slug, fileId }: RunArgs): Promise<RunResult> {
        if (!slug) return { status: 'skipped', detail: 'no slug (untyped) — cannot partition' };
        const sectionResultId = (record.section_result_id as string) ?? null;
        const recordUid = sectionResultId || fileId;
        if (!recordUid) return { status: 'skipped', detail: 'no record_uid (no section_result_id and no fileId)' };

        const dims = recordDims(record);
        const mkRow = (section_key: string, row_index: number, data: Record<string, unknown>): SideEffect => ({
            table: 'extracted_records',
            row: {
                file_id: fileId,
                slug,
                section_result_id: sectionResultId,
                record_uid: recordUid,
                section_key,
                row_index,
                data,
                ...dims,
                ...rowDims(data),
                projector_version: PROJECTOR_VERSION,
            },
        });

        // Split the record into a _root header (objects/scalars) and array sections.
        const rootData: Record<string, unknown> = {};
        const arraySections: Array<[string, Record<string, unknown>[]]> = [];
        for (const [k, v] of Object.entries(record)) {
            if (isArraySection(v)) arraySections.push([k, v]);
            else rootData[k] = v;
        }

        const sideEffects: SideEffect[] = [mkRow('_root', 0, rootData)];
        for (const [key, arr] of arraySections) {
            arr.forEach((el, i) => sideEffects.push(mkRow(key, i, el)));
        }

        return {
            status: 'applied',
            detail: `${sideEffects.length} rows (${arraySections.length} array sections)`,
            sideEffects,
        };
    },
};

export default projectRecords;
