import { describe, it, expect } from 'vitest';
import translate from '../translate.ts';
import type { SlugCatalog } from '../../types.ts';

const catalog: SlugCatalog = {
    slug: 'mgs_well_log',
    schemaVersion: 1,
    sections: [{ key: '_root', kind: 'object' }, { key: 'pluggings', kind: 'array' }],
    promotedColumns: ['county', 'depth_bottom', 'event_date', 'latitude', 'longitude', 'record_label'],
    fields: [
        { name: 'county', type: 'string', section: '_root', promotedColumn: 'county' },
        { name: 'measured_depth', type: 'number', section: '_root', promotedColumn: 'depth_bottom' },
        { name: 'well_type', type: 'string', section: '_root' },
    ],
};

/** A stub that records the prompt it received and returns a canned JSON string. */
const stub = (json: object) => {
    let seen = '';
    const complete = async ({ user }: { user: string }) => { seen = user; return JSON.stringify(json); };
    return { complete, prompt: () => seen };
};

describe('translate', () => {
    it('parses the model JSON and injects the slug server-side', async () => {
        const s = stub({ section: '_root', where: [{ field: 'county', op: 'eq', value: 'Livingston' }] });
        const spec = await translate('wells in Livingston County', catalog, { complete: s.complete });
        expect(spec.slug).toBe('mgs_well_log');         // injected, not from the model
        expect(spec.section).toBe('_root');
        expect(spec.where).toEqual([{ field: 'county', op: 'eq', value: 'Livingston' }]);
    });

    it('passes the field catalog to the model', async () => {
        const s = stub({ section: '_root', where: [] });
        await translate('anything', catalog, { complete: s.complete });
        expect(s.prompt()).toContain('county');
        expect(s.prompt()).toContain('measured_depth');
        expect(s.prompt()).toContain('Question: anything');
    });

    it('defaults section to _root and where to [] when the model omits them', async () => {
        const s = stub({});
        const spec = await translate('q', catalog, { complete: s.complete });
        expect(spec.section).toBe('_root');
        expect(spec.where).toEqual([]);
    });

    it('passes through a geo filter', async () => {
        const s = stub({ section: '_root', where: [], geo: { withinMiles: 5, lat: 43.6, lon: -84.2 } });
        const spec = await translate('within 5 miles of 43.6, -84.2', catalog, { complete: s.complete });
        expect(spec.geo).toEqual({ withinMiles: 5, lat: 43.6, lon: -84.2 });
    });

    it('throws a clear error on non-JSON model output', async () => {
        const complete = async () => 'not json at all';
        await expect(translate('q', catalog, { complete })).rejects.toThrow(/valid JSON/);
    });
});
