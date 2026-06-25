import { describe, it, expect } from 'vitest';
import compile, { CompileError, DEFAULT_LIMIT, MAX_LIMIT } from '../compile.ts';
import type { SlugCatalog, FilterSpec } from '../../types.ts';

const catalog: SlugCatalog = {
    slug: 'mgs_well_log',
    schemaVersion: 1,
    sections: [{ key: '_root', kind: 'object' }, { key: 'pluggings', kind: 'array' }],
    promotedColumns: ['latitude', 'longitude', 'county', 'state', 'event_date', 'depth_top', 'depth_bottom', 'record_label'],
    fields: [
        { name: 'county', type: 'string', section: '_root', promotedColumn: 'county' },
        { name: 'measured_depth', type: 'number', section: '_root', promotedColumn: 'depth_bottom' },
        { name: 'completion_date', type: 'date', section: '_root', promotedColumn: 'event_date' },
        { name: 'well_type', type: 'string', section: '_root' },
        { name: 'h2s_present', type: 'boolean', section: '_root' },
    ],
};

const C = (spec: FilterSpec, scope = {}) => compile(spec, catalog, scope);

describe('compile — safety & structure', () => {
    it('always scopes to slug + section and applies a LIMIT', () => {
        const q = C({ slug: 'mgs_well_log' });
        expect(q.sql).toMatch(/FROM extracted_records WHERE slug = \$1 AND section_key = \$2/);
        expect(q.params.slice(0, 2)).toEqual(['mgs_well_log', '_root']);
        expect(q.sql).toMatch(new RegExp(`LIMIT ${DEFAULT_LIMIT}$`));
    });

    it('injects org/job scope when provided', () => {
        const q = C({ slug: 'mgs_well_log' }, { orgId: 'org-1', jobId: 'job-2' });
        expect(q.sql).toContain('org_id = $3');
        expect(q.sql).toContain('job_id = $4');
        expect(q.params).toEqual(expect.arrayContaining(['org-1', 'job-2']));
    });

    it('rejects an unknown field (typo / injection guard)', () => {
        expect(() => C({ slug: 'mgs_well_log', where: [{ field: 'county); DROP TABLE', op: 'eq', value: 'x' }] }))
            .toThrow(CompileError);
    });

    it('binds every value as a parameter (no literal interpolation)', () => {
        const q = C({ slug: 'mgs_well_log', where: [{ field: 'county', op: 'eq', value: "O'Brien" }] });
        expect(q.sql).not.toContain("O'Brien");
        expect(q.params).toContain("O'Brien");
    });

    it('clamps limit to MAX_LIMIT', () => {
        const q = C({ slug: 'mgs_well_log', limit: 999999 });
        expect(q.sql).toMatch(new RegExp(`LIMIT ${MAX_LIMIT}$`));
    });
});

describe('compile — field resolution', () => {
    it('maps a promoted column directly, case-insensitively (county) — query #1', () => {
        const q = C({ slug: 'mgs_well_log', where: [{ field: 'county', op: 'eq', value: 'Livingston' }] });
        expect(q.sql).toMatch(/county ILIKE \$3 ESCAPE/); // case-insensitive: matches Livingston / LIVINGSTON
        expect(q.params).toContain('Livingston');
    });

    it('maps a synonym field to its promoted column (measured_depth → depth_bottom) — query #2', () => {
        const q = C({
            slug: 'mgs_well_log',
            where: [{ field: 'county', op: 'eq', value: 'Midland' }, { field: 'measured_depth', op: 'gt', value: 8000 }],
        });
        expect(q.sql).toContain('depth_bottom > ');
        expect(q.params).toContain(8000);
    });

    it('compiles a date filter on the promoted column — query #3', () => {
        const q = C({ slug: 'mgs_well_log', where: [{ field: 'completion_date', op: 'gt', value: '2010-01-01' }] });
        expect(q.sql).toContain('event_date > ');
        expect(q.params).toContain('2010-01-01');
    });

    it('accesses a non-promoted field via bound-key data->> with a cast — query #4', () => {
        const q = C({
            slug: 'mgs_well_log',
            where: [
                { field: 'well_type', op: 'ilike', value: '%injection%' },
                { field: 'h2s_present', op: 'eq', value: true },
            ],
        });
        expect(q.sql).toContain('(data ->> $3) ILIKE $4');       // well_type, key bound as param
        expect(q.sql).toContain('(data ->> $5)::boolean = $6');  // h2s_present cast
        expect(q.params).toEqual(expect.arrayContaining(['well_type', '%injection%', 'h2s_present', true]));
    });

    it('compiles a geospatial radius on lat/lon — query #5', () => {
        const q = C({ slug: 'mgs_well_log', geo: { withinMiles: 5, lat: 43.6, lon: -84.2 } });
        expect(q.sql).toContain('3958.8 * acos');
        expect(q.sql).toContain('<= ');
        expect(q.params).toEqual(expect.arrayContaining([43.6, -84.2, 5]));
    });
});

describe('compile — ops', () => {
    it('handles in / is_null / not_null', () => {
        const inq = C({ slug: 'mgs_well_log', where: [{ field: 'county', op: 'in', value: ['A', 'B'] }] });
        expect(inq.sql).toContain('county = ANY($3)');
        expect(C({ slug: 'mgs_well_log', where: [{ field: 'county', op: 'is_null' }] }).sql).toContain('county IS NULL');
        expect(C({ slug: 'mgs_well_log', where: [{ field: 'county', op: 'not_null' }] }).sql).toContain('county IS NOT NULL');
    });

    it('rejects in with a non-array and comparison with no value', () => {
        expect(() => C({ slug: 'mgs_well_log', where: [{ field: 'county', op: 'in', value: 'x' }] })).toThrow(CompileError);
        expect(() => C({ slug: 'mgs_well_log', where: [{ field: 'county', op: 'eq' }] })).toThrow(CompileError);
    });
});
