/**
 * formatter — query rows → a clean, human-readable table + CSV, plus a plain
 * description of the interpreted filter (the "echo" that makes the result
 * trustworthy: the user sees exactly what was searched). html/graphs come later.
 */

import type { FilterSpec, Condition } from '../types.ts';

export interface FormattedResult {
    explainerText: string;
    columns: string[];
    rows: Record<string, unknown>[];
    csv: string;
    rowCount: number;
}

// Internal columns we hide from the default table view.
const HIDDEN = new Set(['file_id', 'data', 'section_key', 'row_index']);

const opText: Record<Condition['op'], string> = {
    eq: '=', neq: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤',
    in: 'in', like: 'matches', ilike: 'contains', is_null: 'is empty', not_null: 'is present',
};

/** A plain-English description of what the query actually searched for. */
export function describeSpec(spec: FilterSpec): string {
    const parts: string[] = [`${spec.slug}`];
    if (spec.section && spec.section !== '_root') parts.push(`section "${spec.section}"`);
    const conds = (spec.where ?? []).map((c) => {
        if (c.op === 'is_null' || c.op === 'not_null') return `${c.field} ${opText[c.op]}`;
        const v = Array.isArray(c.value) ? `[${c.value.join(', ')}]` : String(c.value);
        return `${c.field} ${opText[c.op]} ${v}`;
    });
    if (spec.geo) conds.push(`within ${spec.geo.withinMiles} mi of (${spec.geo.lat}, ${spec.geo.lon})`);
    const where = conds.length ? ` where ${conds.join(' AND ')}` : '';

    if (spec.aggregates && spec.aggregates.length > 0) {
        const aggText = spec.aggregates
            .map((a) => (a.fn === 'count' && !a.field ? 'count' : `${a.fn}(${a.field})`))
            .join(', ');
        const by = spec.groupBy && spec.groupBy.length ? ` by ${spec.groupBy.join(', ')}` : '';
        return `Showing ${aggText} of ${parts.join(', ')}${where}${by}`;
    }
    return `Showing ${parts.join(', ')}${where}`;
}

const csvCell = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function formatRows(
    rows: Record<string, unknown>[],
    spec: FilterSpec,
    opts: { includeHidden?: boolean } = {},
): FormattedResult {
    const allKeys = rows.length ? Object.keys(rows[0]) : [];
    const columns = opts.includeHidden ? allKeys : allKeys.filter((k) => !HIDDEN.has(k));

    const header = columns.map(csvCell).join(',');
    const body = rows.map((r) => columns.map((c) => csvCell(r[c])).join(',')).join('\n');
    const csv = rows.length ? `${header}\n${body}` : header;

    const explainerText = `${describeSpec(spec)} — ${rows.length} ${rows.length === 1 ? 'record' : 'records'}.`;

    return { explainerText, columns, rows, csv, rowCount: rows.length };
}

export default formatRows;
