/**
 * Wellogic-format multi-tab Excel export (Phase 2, D4).
 *
 * Produces a 2-tab .xlsx modeled on Michigan Wellogic: a Wells tab (one row per
 * record, mapped to Wellogic columns, with coordinates + precision joined from
 * record_geocodes) and a Lithology tab (one row per interval, linked by WELLID).
 *
 * The reshape is done in SQL (DB > backend > frontend): the DB projects records
 * to Wellogic columns and LEFT JOINs record_geocodes; the backend only assembles
 * the workbook (SQL can't emit .xlsx).
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

// Wells tab: header label → how it appears. Order is the column order.
const WELL_COLUMNS = [
    { header: 'WELLID', key: 'wellid' },
    { header: 'COUNTY', key: 'county' },
    { header: 'TOWN', key: 'town' },
    { header: 'RANGE', key: 'range' },
    { header: 'SECTION', key: 'section' },
    { header: 'WELL_ADDR', key: 'well_addr' },
    { header: 'LATITUDE', key: 'latitude' },
    { header: 'LONGITUDE', key: 'longitude' },
    { header: 'COORD_PRECISION', key: 'precision_tier' },
    { header: 'COORD_SOURCE', key: 'coord_source' },
    { header: 'WELL_DEPTH', key: 'well_depth' },
    { header: 'LOG_DATE', key: 'log_date' },
    { header: 'DRILL_METH', key: 'drill_meth' },
    { header: 'CASE_DIA', key: 'case_dia' },
    { header: 'CASE_DEPTH', key: 'case_depth' },
    { header: 'SCREEN_FRM', key: 'screen_frm' },
    { header: 'SCREEN_TO', key: 'screen_to' },
];

const LITHOLOGY_COLUMNS = [
    { header: 'WELLID', key: 'wellid' },
    { header: 'DEPTH_FROM_FT', key: 'depth_from_ft' },
    { header: 'DEPTH_TO_FT', key: 'depth_to_ft' },
    { header: 'PRIMARY_MATERIAL', key: 'primary_material' },
    { header: 'SECONDARY_MATERIAL', key: 'secondary_material' },
    { header: 'GRAIN_SIZE', key: 'grain_size' },
    { header: 'USCS', key: 'uscs_symbol' },
    { header: 'COLOR', key: 'color' },
    { header: 'VOC_PPM', key: 'voc_ppm' },
];

const WELLS_SQL = `${RECORD_EXPAND_CTE}
SELECT
    record->'site_identification'->>'boring_well_id'        AS wellid,
    record->'site_identification'->>'county'               AS county,
    record->'site_identification'->>'township'            AS town,
    record->'site_identification'->>'range'               AS range,
    record->'site_identification'->>'section'             AS section,
    record->'site_identification'->>'site_address'        AS well_addr,
    g.latitude, g.longitude, g.precision_tier, g.strategy AS coord_source,
    record->'drilling_and_personnel'->>'total_depth_ft'   AS well_depth,
    record->'document_metadata'->>'log_date'              AS log_date,
    record->'drilling_and_personnel'->>'drilling_method'  AS drill_meth,
    record->'well_construction'->>'casing_diameter_in'    AS case_dia,
    record->'well_construction'->>'casing_to_ft'          AS case_depth,
    record->'well_construction'->>'screen_from_ft'        AS screen_frm,
    record->'well_construction'->>'screen_to_ft'          AS screen_to
FROM typed
LEFT JOIN record_geocodes g ON g.section_result_id = typed.record->>'section_result_id'
WHERE typed.eff_slug = $2
ORDER BY typed.created_at DESC, typed.file_id, typed.idx`;

const LITHOLOGY_SQL = `${RECORD_EXPAND_CTE}
SELECT
    record->'site_identification'->>'boring_well_id'  AS wellid,
    li.elem->>'depth_from_ft'      AS depth_from_ft,
    li.elem->>'depth_to_ft'        AS depth_to_ft,
    li.elem->>'primary_material'   AS primary_material,
    li.elem->>'secondary_material' AS secondary_material,
    li.elem->'grain_size_percentages' AS grain_size,
    li.elem->>'uscs_symbol'        AS uscs_symbol,
    li.elem->>'color_description'  AS color,
    li.elem->>'field_screening_voc_ppm' AS voc_ppm
FROM typed
CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(record->'lithology_intervals') = 'array'
         THEN record->'lithology_intervals' ELSE '[]'::jsonb END
) WITH ORDINALITY AS li(elem, ord)
WHERE eff_slug = $2 AND jsonb_typeof(li.elem) = 'object'
ORDER BY created_at DESC, file_id, idx, li.ord`;

export interface WellogicData {
    wells: Record<string, unknown>[];
    lithology: Record<string, unknown>[];
}

/** Run the SQL reshape for a preview + slug. */
export async function getWellogicExportData(itemIds: string[], slug: string): Promise<WellogicData> {
    if (!itemIds || itemIds.length === 0) return { wells: [], lithology: [] };
    const client = await pool.connect();
    try {
        const wells = await client.query(WELLS_SQL, [itemIds, slug]);
        const lithology = await client.query(LITHOLOGY_SQL, [itemIds, slug]);
        return {
            wells: wells.rows,
            lithology: lithology.rows.map((r: Record<string, unknown>) => ({ ...r, grain_size: formatGrainSize(r.grain_size) })),
        };
    } finally {
        client.release();
    }
}

/** Build the 2-tab workbook and stream it to a writable (the HTTP response). */
export async function writeWellogicWorkbook(data: WellogicData, stream: Writable): Promise<void> {
    const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream });

    const wells = wb.addWorksheet('Wells');
    wells.columns = WELL_COLUMNS.map((c) => ({ header: c.header, key: c.key }));
    wells.getRow(1).font = { bold: true };
    for (const row of data.wells) wells.addRow(row).commit();
    wells.commit();

    const lith = wb.addWorksheet('Lithology');
    lith.columns = LITHOLOGY_COLUMNS.map((c) => ({ header: c.header, key: c.key }));
    lith.getRow(1).font = { bold: true };
    for (const row of data.lithology) lith.addRow(row).commit();
    lith.commit();

    await wb.commit();
}

export default { getWellogicExportData, writeWellogicWorkbook, formatGrainSize };
