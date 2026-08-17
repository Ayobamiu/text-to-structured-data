/**
 * Generic Excel export for a demo extraction result (V1 or V2 envelope).
 * One Summary sheet of flattened scalars, plus a sheet per interval array.
 * Empty values stay empty — we do not invent data.
 */

import ExcelJS from 'exceljs';

const SKIP_KEYS = new Set([
    'section_result_id',
    'record_id',
    'extraction_metadata',
    'source_locations',
]);

const ACRONYMS = new Set(['id', 'spt', 'uscs', 'plss', 'gps', 'dgps', 'qa']);

export function humanizeKey(key) {
    return String(key)
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .split(/[_\s]+/)
        .filter(Boolean)
        .map((w) => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
        .join(' ');
}

export function flattenScalars(obj, prefix = '') {
    const out = {};
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
    for (const [k, v] of Object.entries(obj)) {
        if (SKIP_KEYS.has(k)) continue;
        const label = prefix ? `${humanizeKey(prefix)} / ${humanizeKey(k)}` : humanizeKey(k);
        if (v == null || v === '') {
            if (!Array.isArray(v)) out[label] = '';
            continue;
        }
        if (Array.isArray(v)) continue;
        if (typeof v === 'object') {
            Object.assign(out, flattenScalars(v, k));
            continue;
        }
        if (typeof v === 'boolean') {
            out[label] = v ? 'Yes' : 'No';
        } else {
            out[label] = v;
        }
    }
    return out;
}

function collectArraySheets(records) {
    /** @type {Map<string, { headerSet: Set<string>, rows: object[] }>} */
    const sheets = new Map();
    for (const { slug, record, index } of records) {
        const wellLabel =
            record?.site_identification?.boring_well_id ||
            record?.well_number ||
            record?.section_result_id ||
            `${slug || 'record'} ${index + 1}`;
        for (const [k, v] of Object.entries(record || {})) {
            if (!Array.isArray(v) || v.length === 0) continue;
            if (!v.every((item) => item && typeof item === 'object' && !Array.isArray(item))) continue;
            if (!sheets.has(k)) sheets.set(k, { headerSet: new Set(), rows: [] });
            const sheet = sheets.get(k);
            for (const item of v) {
                const flat = flattenScalars(item);
                Object.keys(flat).forEach((h) => sheet.headerSet.add(h));
                sheet.rows.push({ Record: wellLabel, Type: slug || '', ...flat });
            }
        }
    }
    return sheets;
}

export function listDemoRecords(result) {
    if (!result || typeof result !== 'object') return [];
    const keys = Object.keys(result);
    const looksV2 = keys.some((k) => {
        const val = result[k];
        return Array.isArray(val) && val[0] && typeof val[0] === 'object' && val[0].section_result_id;
    });
    if (looksV2) {
        const records = [];
        for (const [slug, arr] of Object.entries(result)) {
            if (!Array.isArray(arr)) continue;
            arr.forEach((record, index) => {
                if (record && typeof record === 'object') records.push({ slug, index, record });
            });
        }
        return records;
    }
    return [{ slug: null, index: 0, record: result }];
}

export async function writeDemoWorkbook(result, { filename } = {}) {
    const records = listDemoRecords(result);
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Core Extract';
    wb.created = new Date();

    const summaryRows = records.map(({ slug, record, index }) => ({
        Record: record?.site_identification?.boring_well_id || `${slug || 'Record'} ${index + 1}`,
        Type: slug || '',
        Source: filename || record?.extraction_metadata?.source_file || '',
        ...flattenScalars(record),
    }));

    const summaryHeaders = [];
    const seen = new Set();
    for (const row of summaryRows) {
        for (const h of Object.keys(row)) {
            if (!seen.has(h)) {
                seen.add(h);
                summaryHeaders.push(h);
            }
        }
    }

    const summary = wb.addWorksheet('Summary');
    if (summaryHeaders.length === 0) {
        summary.addRow(['No extracted fields']);
    } else {
        summary.addRow(summaryHeaders);
        summary.getRow(1).font = { bold: true };
        for (const row of summaryRows) {
            summary.addRow(summaryHeaders.map((h) => (row[h] == null ? '' : row[h])));
        }
        summary.columns.forEach((col) => {
            col.width = Math.min(28, Math.max(12, String(col.header || '').length + 2));
        });
    }

    const arraySheets = collectArraySheets(records);
    for (const [key, { headerSet, rows }] of arraySheets) {
        const headers = ['Record', 'Type', ...headerSet];
        const sheet = wb.addWorksheet(humanizeKey(key).slice(0, 31));
        sheet.addRow(headers);
        sheet.getRow(1).font = { bold: true };
        for (const row of rows) {
            sheet.addRow(headers.map((h) => (row[h] == null ? '' : row[h])));
        }
    }

    const buf = await wb.xlsx.writeBuffer();
    return Buffer.from(buf);
}
