/**
 * The eval set — the 5 sample queries (difficulty ladder) plus a predicate check
 * for each. A query passes when EVERY returned row satisfies the predicate and at
 * least `minRows` rows came back. The loop iterates the translator until 5/5.
 */

export interface SampleQuery {
    id: number;
    question: string;
    slug: string;
    minRows: number;
    /** Return null on pass, or a human reason on failure. */
    check: (rows: Record<string, unknown>[]) => string | null;
}

const num = (v: unknown): number => Number(typeof v === 'string' ? v.replace(/,/g, '') : v);
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const data = (r: Record<string, unknown>) => (r.data ?? {}) as Record<string, unknown>;
/** Normalize a county value: lowercase, strip a trailing " County". */
const county = (r: Record<string, unknown>): string => str(r.county).toLowerCase().replace(/\s+county$/, '').trim();
const isTrue = (v: unknown): boolean => v === true || str(v).toLowerCase() === 'true';

/** Great-circle miles between two lat/lon points. */
function haversineMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const toRad = (d: number) => (d * Math.PI) / 180;
    const R = 3958.8;
    const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

const everyRow = (rows: Record<string, unknown>[], pred: (r: Record<string, unknown>) => boolean, why: string): string | null => {
    const bad = rows.find((r) => !pred(r));
    return bad ? `${why} — offending row: ${JSON.stringify({ county: bad.county, depth_bottom: bad.depth_bottom, event_date: bad.event_date, lat: bad.latitude, lon: bad.longitude })}` : null;
};

export const SAMPLE_QUERIES: SampleQuery[] = [
    {
        id: 1,
        question: 'Show all wells in Livingston County',
        slug: 'mgs_well_log',
        minRows: 1, // ground truth: many Livingston wells (case variants Livingston/LIVINGSTON)
        check: (rows) => everyRow(rows, (r) => county(r) === 'livingston', 'county is not Livingston'),
    },
    {
        id: 2,
        question: 'Wells in Jackson County deeper than 4000 feet',
        slug: 'mgs_well_log',
        minRows: 1, // ground truth: ~587 Jackson wells over 4000 ft
        check: (rows) => everyRow(rows, (r) => county(r) === 'jackson' && num(r.depth_bottom) > 4000, 'county≠Jackson or depth≤4000'),
    },
    {
        id: 3,
        question: 'Wells completed after 2010',
        slug: 'mgs_well_log',
        minRows: 1, // ground truth: 115 wells
        check: (rows) => everyRow(rows, (r) => !!r.event_date && new Date(str(r.event_date)) > new Date('2010-01-01'), 'event_date not after 2010'),
    },
    {
        id: 4,
        question: 'Injection wells with H2S present',
        slug: 'mgs_well_log',
        minRows: 1, // ground truth: 1 well (injection_well=true AND h2s_present=true)
        check: (rows) => everyRow(rows, (r) => isTrue(data(r).injection_well) && isTrue(data(r).h2s_present), 'not an injection well or H2S not present'),
    },
    {
        id: 5,
        question: 'Wells within 10 miles of 42.14, -84.37',
        slug: 'mgs_well_log',
        minRows: 1, // ground truth: ~160 wells near the Jackson centroid
        check: (rows) => everyRow(rows, (r) => r.latitude != null && r.longitude != null && haversineMiles(num(r.latitude), num(r.longitude), 42.14, -84.37) <= 10.01, 'outside 10 mile radius'),
    },
];

export default SAMPLE_QUERIES;
