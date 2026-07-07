/**
 * Wellogic-format multi-tab Excel export (Phase 2, D4).
 *
 * Produces an .xlsx modeled on Michigan Wellogic: a Wells tab (one row per record,
 * mapped to Wellogic columns, with coordinates + precision joined from
 * record_geocodes, and county/township/city/zip filled from the geocoder where the
 * document left them blank) plus one tab per one-to-many array (Lithology, SPT,
 * Samples, Groundwater), each linked by WELLID.
 *
 * The reshape is done in SQL (DB > backend > frontend): the DB projects records to
 * columns and LEFT JOINs record_geocodes; the backend only assembles the workbook.
 * See WELLOGIC_EXPORT_AND_GEOCODING.md for the full mapping + provenance.
 */

import type { Writable } from 'node:stream';
import ExcelJS from 'exceljs';
import pool from '../database.js';
import { RECORD_EXPAND_CTE } from '../database/previewDataTable.js';

export interface GrainFraction { percent?: number; fraction?: string }

/** "[{percent:85,fraction:'sand'},…]" → "sand 85%, silt_clay 5%". Pure, testable. */
export function formatGrainSize(grain: unknown): string {
    if (!Array.isArray(grain)) return '';
    return (grain as GrainFraction[])
        .filter((g) => g && g.fraction != null)
        .map((g) => (g.percent != null ? `${g.fraction} ${g.percent}%` : String(g.fraction)))
        .join(', ');
}

// ── Wells tab ────────────────────────────────────────────────────────────────
// WELLID is the section_result_id (globally unique, stable, never null) so ArcGIS
// Joins/Relates have a safe key — the extracted boring_well_id collides badly
// (~36% of records share a label like "MW-1"). The original label is kept as
// WELL_LABEL for display, and SRC_FILE/FILE_ID point back to the source document.
const WELL_COLUMNS = [
    'WELLID', 'WELL_LABEL', 'SRC_FILE', 'FILE_ID',
    'COUNTY', 'TOWNSHIP', 'TOWN', 'RANGE', 'SECTION',
    'WELL_ADDR', 'WELL_CITY', 'WELL_ZIP',
    'LATITUDE', 'LONGITUDE', 'COORD_PRECISION', 'COORD_SOURCE',
    'WELL_DEPTH', 'LOG_DATE', 'DRILL_METH', 'CASE_DIA', 'CASE_DEPTH', 'SCREEN_FRM', 'SCREEN_TO',
].map((h) => ({ header: h, key: h.toLowerCase() }));

const WELLS_SQL = `${RECORD_EXPAND_CTE}
SELECT
    typed.record->>'section_result_id'                                          AS wellid,
    record->'site_identification'->>'boring_well_id'                             AS well_label,
    typed.filename                                                               AS src_file,
    typed.file_id                                                                AS file_id,
    COALESCE(NULLIF(record->'site_identification'->>'county',''), g.geocoded_county) AS county,
    g.geocoded_township                                                          AS township,
    record->'site_identification'->>'township'                                   AS town,
    record->'site_identification'->>'range'                                      AS range,
    record->'site_identification'->>'section'                                    AS section,
    record->'site_identification'->>'site_address'                              AS well_addr,
    g.geocoded_city                                                             AS well_city,
    g.geocoded_postal_code                                                      AS well_zip,
    g.latitude, g.longitude,
    g.precision_tier AS coord_precision, g.strategy AS coord_source,
    record->'drilling_and_personnel'->>'total_depth_ft'                         AS well_depth,
    record->'document_metadata'->>'log_date'                                    AS log_date,
    record->'drilling_and_personnel'->>'drilling_method'                        AS drill_meth,
    record->'well_construction'->>'casing_diameter_in'                          AS case_dia,
    record->'well_construction'->>'casing_to_ft'                                AS case_depth,
    record->'well_construction'->>'screen_from_ft'                              AS screen_frm,
    record->'well_construction'->>'screen_to_ft'                                AS screen_to
FROM typed
LEFT JOIN record_geocodes g ON g.section_result_id = typed.record->>'section_result_id'
WHERE typed.eff_slug = $2
ORDER BY typed.created_at DESC, typed.file_id, typed.idx`;

// ── Wellogic tab ─────────────────────────────────────────────────────────────
// A flat, one-row-per-well sheet matching the REAL Michigan Wellogic Wells export
// (…/EGLE/DwOpenData/MapServer/3) column-for-column, so it's drop-in for the ArcGIS
// symbology/templates Khalid already uses. This is how Wellogic answers "one sheet":
// one mappable row per well with X/Y up front — the subsurface is SUMMARIZED into
// columns, not listed as intervals. We populate every field we can map today; the
// aquifer/hydraulic summary (AQ_*, H_COND_*, TRANSMSV_*, TOPAQ/BOTAQ — from the
// aquifer_test type) and array-derived SWL/ROCK_TOP are left blank for a follow-up.
const WELLOGIC_HEADERS = [
    'X', 'Y', 'OBJECTID', 'WELLID', 'COUNTY', 'PERMIT_NUM', 'TOWNSHIP', 'TOWN', 'RANGE', 'SECTION',
    'OWNER_NAME', 'WELL_ADDR', 'WELL_CITY', 'WELL_ZIP', 'WELL_DEPTH', 'WELL_TYPE', 'TYPE_OTHER',
    'WEL_STATUS', 'STATUS_OTH', 'WSSN', 'WELL_NUM', 'DRILLER_ID', 'DRILL_METH', 'METH_OTHER',
    'CONST_DATE', 'CASE_TYPE', 'CASE_OTHER', 'CASE_DIA', 'CASE_DEPTH', 'SCREEN_FRM', 'SCREEN_TO',
    'SWL', 'FLOWING', 'AQ_TYPE', 'TEST_DEPTH', 'TEST_HOURS', 'TEST_RATE', 'TEST_METHD', 'TEST_OTHER',
    'GROUT', 'PMP_CPCITY', 'LATITUDE', 'LONGITUDE', 'METHD_COLL', 'ELEVATION', 'ELEV_METHD',
    'WITHIN_CO', 'WITHIN_SEC', 'LOC_MATCH', 'SEC_DIST', 'ELEV_DEM', 'ELEV_DIF', 'LANDSYS',
    'DEPTH_FLAG', 'ELEV_FLAG', 'SWL_FLAG', 'SPC_CPCITY', 'AQ_CODE', 'ROCK_TOP', 'AQ_THK_1', 'AQ_THK_2',
    'AQ_THK_D', 'H_COND_1', 'H_COND_2', 'V_COND_1', 'V_COND_2', 'TRANSMSV_1', 'TRANSMSV_2', 'B_AQ_THK',
    'B_H_COND', 'B_V_COND', 'B_TRANS', 'AQ_THICK_D', 'H_COND_D', 'V_COND_D', 'TRANS_D', 'AQ_FLAG',
    'SCRN_FLAG', 'NOTES', 'WELLCODE', 'TOPAQ', 'BOTAQ', 'WWAT_ID',
];
const WELLOGIC_COLUMNS = WELLOGIC_HEADERS.map((h) => ({ header: h, key: h.toLowerCase() }));

// X/Y = EPSG:3857 (Web Mercator) computed from lat/long so the sheet plots directly,
// exactly like the Wellogic export. WELLID = section_result_id (unique join key);
// the human boring label goes in WELL_NUM. Unmapped Wellogic columns stay blank.
const WELLOGIC_SQL = `${RECORD_EXPAND_CTE}
SELECT
    g.longitude * 6378137.0 * pi() / 180.0                                        AS x,
    CASE WHEN g.latitude IS NOT NULL
         THEN 6378137.0 * ln(tan(pi()/4 + radians(g.latitude)/2)) END              AS y,
    typed.record->>'section_result_id'                                            AS wellid,
    COALESCE(NULLIF(record->'site_identification'->>'county',''), g.geocoded_county) AS county,
    record->'well_construction'->>'permit_number'                                 AS permit_num,
    g.geocoded_township                                                           AS township,
    record->'site_identification'->>'township'                                    AS town,
    record->'site_identification'->>'range'                                       AS range,
    record->'site_identification'->>'section'                                     AS section,
    record->'site_identification'->>'site_address'                               AS well_addr,
    g.geocoded_city                                                              AS well_city,
    g.geocoded_postal_code                                                       AS well_zip,
    record->'drilling_and_personnel'->>'total_depth_ft'                          AS well_depth,
    record->'document_metadata'->'document_type'->>0                             AS well_type,
    record->'site_identification'->>'boring_well_id'                             AS well_num,
    record->'drilling_and_personnel'->>'drilling_method'                         AS drill_meth,
    record->'document_metadata'->>'log_date'                                     AS const_date,
    record->'well_construction'->>'casing_diameter_in'                           AS case_dia,
    record->'well_construction'->>'casing_to_ft'                                 AS case_depth,
    record->'well_construction'->>'screen_from_ft'                              AS screen_frm,
    record->'well_construction'->>'screen_to_ft'                                AS screen_to,
    record->'well_construction'->>'grout_type'                                  AS grout,
    g.latitude, g.longitude,
    g.strategy                                                                   AS methd_coll,
    record->'site_identification'->>'ground_elevation_ft'                        AS elevation
FROM typed
LEFT JOIN record_geocodes g ON g.section_result_id = typed.record->>'section_result_id'
WHERE typed.eff_slug = $2
ORDER BY typed.created_at DESC, typed.file_id, typed.idx`;

// ── Interval tabs (one row per array element, linked by WELLID) ───────────────
interface IntervalCol { header: string; key: string; json: string; jsonb?: boolean }
interface IntervalTab { sheet: string; arrayKey: string; cols: IntervalCol[] }

const INTERVAL_TABS: IntervalTab[] = [
    { sheet: 'Lithology', arrayKey: 'lithology_intervals', cols: [
        { header: 'DEPTH_FROM_FT', key: 'depth_from_ft', json: 'depth_from_ft' },
        { header: 'DEPTH_TO_FT', key: 'depth_to_ft', json: 'depth_to_ft' },
        { header: 'PRIMARY_MATERIAL', key: 'primary_material', json: 'primary_material' },
        { header: 'SECONDARY_MATERIAL', key: 'secondary_material', json: 'secondary_material' },
        { header: 'GRAIN_SIZE', key: 'grain_size', json: 'grain_size_percentages', jsonb: true },
        { header: 'USCS', key: 'uscs_symbol', json: 'uscs_symbol' },
        { header: 'COLOR', key: 'color', json: 'color_description' },
        { header: 'VOC_PPM', key: 'voc_ppm', json: 'field_screening_voc_ppm' },
    ] },
    { sheet: 'SPT', arrayKey: 'spt_intervals', cols: [
        { header: 'TEST_DEPTH_FT', key: 'test_depth_ft', json: 'test_depth_ft' },
        { header: 'N_VALUE', key: 'n_value', json: 'n_value' },
        { header: 'BLOWS_SEATING_6IN', key: 'blows_seating_6in', json: 'blows_seating_6in' },
        { header: 'BLOWS_2ND_6IN', key: 'blows_2nd_6in', json: 'blows_2nd_6in' },
        { header: 'BLOWS_3RD_6IN', key: 'blows_3rd_6in', json: 'blows_3rd_6in' },
        { header: 'BLOWS_LAST_12IN', key: 'blows_last_12in', json: 'blows_last_12in' },
        { header: 'RECOVERY_IN', key: 'recovery_in', json: 'recovery_in' },
        { header: 'REFUSAL', key: 'refusal', json: 'refusal' },
        { header: 'SAMPLE_ID', key: 'sample_id', json: 'sample_id' },
    ] },
    { sheet: 'Samples', arrayKey: 'samples_collected', cols: [
        { header: 'SAMPLE_ID', key: 'sample_id', json: 'sample_id' },
        { header: 'SAMPLE_TYPE', key: 'sample_type', json: 'sample_type' },
        { header: 'DEPTH_FT', key: 'depth_ft', json: 'depth_ft' },
        { header: 'COLLECTION_DATE', key: 'collection_date', json: 'collection_date' },
        { header: 'COLLECTION_TIME', key: 'collection_time', json: 'collection_time' },
        { header: 'LAB_ID', key: 'lab_id', json: 'lab_id' },
        { header: 'NOTES', key: 'notes', json: 'notes' },
    ] },
    { sheet: 'Groundwater', arrayKey: 'groundwater_observations', cols: [
        { header: 'OBSERVATION_TYPE', key: 'observation_type', json: 'observation_type' },
        { header: 'DEPTH_FT', key: 'depth_ft', json: 'depth_ft' },
        { header: 'DEPTH_REFERENCE', key: 'depth_reference', json: 'depth_reference' },
        { header: 'MEASUREMENT_DATE', key: 'measurement_date', json: 'measurement_date' },
        { header: 'MEASUREMENT_TIME', key: 'measurement_time', json: 'measurement_time' },
        { header: 'MEASUREMENT_METHOD', key: 'measurement_method', json: 'measurement_method' },
        { header: 'HOURS_AFTER_BORING', key: 'hours_after_boring', json: 'hours_after_boring' },
        { header: 'NOTE', key: 'note', json: 'note' },
    ] },
];

function intervalSql(tab: IntervalTab): string {
    const selects = tab.cols
        .map((c) => `x.elem->${c.jsonb ? '' : '>'}'${c.json}' AS ${c.key}`)
        .join(', ');
    return `${RECORD_EXPAND_CTE}
SELECT record->>'section_result_id' AS wellid,
       record->'site_identification'->>'boring_well_id' AS well_label, ${selects}
FROM typed
CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(record->'${tab.arrayKey}') = 'array'
         THEN record->'${tab.arrayKey}' ELSE '[]'::jsonb END
) WITH ORDINALITY AS x(elem, ord)
WHERE typed.eff_slug = $2 AND jsonb_typeof(x.elem) = 'object'
ORDER BY typed.created_at DESC, typed.file_id, typed.idx, x.ord`;
}

export interface WellogicData {
    wellogic: Record<string, unknown>[];
    wells: Record<string, unknown>[];
    tabs: { sheet: string; columns: { header: string; key: string }[]; rows: Record<string, unknown>[] }[];
}

/** Run the SQL reshape for a preview + slug (Wellogic flat sheet + Wells + interval tabs). */
export async function getWellogicExportData(itemIds: string[], slug: string): Promise<WellogicData> {
    if (!itemIds || itemIds.length === 0) return { wellogic: [], wells: [], tabs: [] };
    const client = await pool.connect();
    try {
        const wellogic = await client.query(WELLOGIC_SQL, [itemIds, slug]);
        const wells = await client.query(WELLS_SQL, [itemIds, slug]);
        const tabs = [];
        for (const tab of INTERVAL_TABS) {
            const res = await client.query(intervalSql(tab), [itemIds, slug]);
            const grainCol = tab.cols.find((c) => c.jsonb);
            const rows = grainCol
                ? res.rows.map((r: Record<string, unknown>) => ({ ...r, [grainCol.key]: formatGrainSize(r[grainCol.key]) }))
                : res.rows;
            tabs.push({ sheet: tab.sheet, columns: tab.cols.map((c) => ({ header: c.header, key: c.key })), rows });
        }
        return { wellogic: wellogic.rows, wells: wells.rows, tabs };
    } finally {
        client.release();
    }
}

/** Build the multi-tab workbook and stream it to a writable (the HTTP response). */
export async function writeWellogicWorkbook(data: WellogicData, stream: Writable): Promise<void> {
    const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream });

    // Wellogic flat sheet first — the drop-in, one-row-per-well ArcGIS layer.
    const wellogic = wb.addWorksheet('Wellogic');
    wellogic.columns = WELLOGIC_COLUMNS;
    wellogic.getRow(1).font = { bold: true };
    for (const row of data.wellogic) wellogic.addRow(row).commit();
    wellogic.commit();

    const wells = wb.addWorksheet('Wells');
    wells.columns = WELL_COLUMNS;
    wells.getRow(1).font = { bold: true };
    for (const row of data.wells) wells.addRow(row).commit();
    wells.commit();

    for (const tab of data.tabs) {
        const ws = wb.addWorksheet(tab.sheet);
        ws.columns = [
            { header: 'WELLID', key: 'wellid' },
            { header: 'WELL_LABEL', key: 'well_label' },
            ...tab.columns,
        ];
        ws.getRow(1).font = { bold: true };
        for (const row of tab.rows) ws.addRow(row).commit();
        ws.commit();
    }

    await wb.commit();
}

export default { getWellogicExportData, writeWellogicWorkbook, formatGrainSize };
