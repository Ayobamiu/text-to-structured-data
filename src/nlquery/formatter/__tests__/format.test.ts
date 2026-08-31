import { describe, it, expect } from 'vitest';
import formatRows, { describeSpec } from '../format.ts';
import type { FilterSpec } from '../../types.ts';

const spec: FilterSpec = {
    slug: 'mgs_well_log',
    section: '_root',
    where: [{ field: 'county', op: 'eq', value: 'Livingston' }, { field: 'depth_bottom', op: 'gt', value: 8000 }],
};

describe('describeSpec — the interpreted-filter echo', () => {
    it('renders conditions in plain English', () => {
        expect(describeSpec(spec)).toBe('Showing mgs_well_log where county = Livingston AND depth_bottom > 8000');
    });
    it('describes a geo filter', () => {
        expect(describeSpec({ slug: 'mgs_well_log', where: [], geo: { withinMiles: 5, lat: 43.6, lon: -84.2 } }))
            .toContain('within 5 mi of (43.6, -84.2)');
    });
});

describe('formatRows', () => {
    const rows = [
        { section_key: '_root', file_id: 'f1', record_label: 'API-1', county: 'Livingston', depth_bottom: '9200', data: { well_type: 'injection' } },
        { section_key: '_root', file_id: 'f2', record_label: 'API-2', county: 'Livingston', depth_bottom: '8100', data: { well_type: 'oil' } },
    ];

    it('hides internal columns (file_id, data, section_key) by default', () => {
        const out = formatRows(rows, spec);
        expect(out.columns).toEqual(['record_label', 'county', 'depth_bottom']);
        expect(out.rowCount).toBe(2);
    });

    it('produces CSV with a header and one line per row', () => {
        const out = formatRows(rows, spec);
        const lines = out.csv.split('\n');
        expect(lines[0]).toBe('record_label,county,depth_bottom');
        expect(lines).toHaveLength(3);
    });

    it('escapes CSV cells containing commas or quotes', () => {
        const out = formatRows([{ record_label: 'a,b', county: 'O"Brien' }], { slug: 'x', where: [] });
        expect(out.csv).toContain('"a,b"');
        expect(out.csv).toContain('"O""Brien"');
    });

    it('summarizes in the explainer text', () => {
        expect(formatRows(rows, spec).explainerText).toContain('2 records');
    });
});
