import { describe, it, expect } from 'vitest';
import projectRecords, { toDate, normalizeCounty } from '../services/projectRecords.ts';
import type { RunArgs, SideEffect } from '../types.ts';

describe('normalizeCounty', () => {
    it('collapses case + "County" suffix variants to one canonical form', () => {
        expect(normalizeCounty('JACKSON')).toBe('Jackson');
        expect(normalizeCounty('jackson')).toBe('Jackson');
        expect(normalizeCounty('Jackson County')).toBe('Jackson');
        expect(normalizeCounty('  st. clair ')).toBe('St. Clair');
        expect(normalizeCounty('')).toBeNull();
        expect(normalizeCounty(null)).toBeNull();
    });
});

const run = (record: Record<string, unknown>, slug: string | null, fileId: string | null = 'file-1') =>
    projectRecords.run({ record, slug, fileId, options: {}, cache: new Map(), deps: {} } as RunArgs);

const rowsOf = (ses: SideEffect[] | undefined) => (ses ?? []).map((se) => se.row as Record<string, unknown>);

// A representative flat mgs_well_log record (the dominant slug), with one array section.
const wellRecord = {
    section_result_id: 'sr-123',
    api_number: '21-005-12345',
    county: 'Livingston',
    state: 'MI',
    latitude: 42.6,
    longitude: -83.9,
    measured_depth: 9200,
    completion_date: '1998-06-15',
    well_type: 'injection',
    h2s_present: true,
    pluggings: [
        { plug_number: 1, top: 100, bottom: 200 },
        { plug_number: 2, top: 800, bottom: 900 },
    ],
};

describe('toDate', () => {
    it('parses full dates and bare years; rejects junk', () => {
        expect(toDate('1998-06-15')).toBe('1998-06-15');
        expect(toDate('2010')).toBe('2010-01-01');
        expect(toDate('not a date')).toBeNull();
        expect(toDate(null)).toBeNull();
        expect(toDate('')).toBeNull();
    });
});

describe('project_records', () => {
    it('emits a _root row plus one row per array-section element', async () => {
        const out = await run(wellRecord, 'mgs_well_log');
        expect(out.status).toBe('applied');
        const rows = rowsOf(out.sideEffects);
        // 1 _root + 2 pluggings
        expect(rows).toHaveLength(3);
        const root = rows.find((r) => r.section_key === '_root')!;
        const plugs = rows.filter((r) => r.section_key === 'pluggings');
        expect(plugs.map((r) => r.row_index).sort()).toEqual([0, 1]);
        // _root.data excludes the array section but keeps scalars
        expect(root.data).not.toHaveProperty('pluggings');
        expect((root.data as Record<string, unknown>).api_number).toBe('21-005-12345');
    });

    it('promotes record-level geo/identity onto EVERY row (incl. array rows)', async () => {
        const rows = rowsOf((await run(wellRecord, 'mgs_well_log')).sideEffects);
        for (const r of rows) {
            expect(r.county).toBe('Livingston');
            expect(r.state).toBe('MI');
            expect(r.latitude).toBe(42.6);
            expect(r.longitude).toBe(-83.9);
            expect(r.record_label).toBe('21-005-12345'); // api_number
        }
    });

    it('derives per-row event_date and depth on the _root header', async () => {
        const root = rowsOf((await run(wellRecord, 'mgs_well_log')).sideEffects)
            .find((r) => r.section_key === '_root')!;
        expect(root.event_date).toBe('1998-06-15');
        expect(root.depth_bottom).toBe(9200); // from measured_depth
    });

    it('sets record_uid from section_result_id (V2), else falls back to file_id (V1)', async () => {
        const v2 = rowsOf((await run(wellRecord, 'mgs_well_log')).sideEffects)[0];
        expect(v2.record_uid).toBe('sr-123');
        const { section_result_id, ...v1Record } = wellRecord;
        const v1 = rowsOf((await run(v1Record, 'mgs_well_log', 'file-99')).sideEffects)[0];
        expect(v1.record_uid).toBe('file-99');
        expect(v1.section_result_id).toBeNull();
    });

    it('skips untyped records (no slug — cannot partition)', async () => {
        const out = await run(wellRecord, null);
        expect(out.status).toBe('skipped');
        expect(out.sideEffects ?? []).toHaveLength(0);
    });
});
