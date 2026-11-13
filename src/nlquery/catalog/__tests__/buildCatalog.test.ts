import { describe, it, expect } from 'vitest';
import buildCatalog from '../buildCatalog.ts';

// A fake mgs_well_log-shaped schema: flat scalars + one array-of-object section.
const fakeSchema = {
    type: 'object',
    properties: {
        api_number: { type: ['string', 'null'] },
        county: { type: ['string', 'null'] },
        latitude: { type: ['number', 'null'] },
        measured_depth: { type: ['number', 'null'] },
        completion_date: { type: ['string', 'null'] },
        well_type: { type: ['string', 'null'], description: 'injection/production/etc' },
        pluggings: {
            type: 'array',
            items: { type: 'object', properties: { plug_number: { type: 'integer' }, top: { type: 'number' } } },
        },
    },
};

const fakeDb = {
    query: async () => ({ rows: [{ version: 3, json_schema: fakeSchema }] }),
};

describe('buildCatalog', () => {
    it('parses scalar fields onto _root and arrays into their own section', async () => {
        const cat = await buildCatalog('mgs_well_log', { db: fakeDb });
        expect(cat.slug).toBe('mgs_well_log');
        expect(cat.schemaVersion).toBe(3);
        expect(cat.sections).toEqual(expect.arrayContaining([
            { key: '_root', kind: 'object' },
            { key: 'pluggings', kind: 'array' },
        ]));
        const wellType = cat.fields.find((f) => f.name === 'well_type')!;
        expect(wellType.section).toBe('_root');
        expect(wellType.description).toBe('injection/production/etc');
        const plug = cat.fields.find((f) => f.name === 'plug_number')!;
        expect(plug.section).toBe('pluggings');
        expect(plug.type).toBe('integer');
    });

    it('tags fields that map to a promoted column', async () => {
        const cat = await buildCatalog('mgs_well_log', { db: fakeDb });
        expect(cat.fields.find((f) => f.name === 'county')!.promotedColumn).toBe('county');
        expect(cat.fields.find((f) => f.name === 'measured_depth')!.promotedColumn).toBe('depth_bottom');
        expect(cat.fields.find((f) => f.name === 'completion_date')!.promotedColumn).toBe('event_date');
    });

    it('exposes the promoted columns as the queryable typed dimensions', async () => {
        const cat = await buildCatalog('mgs_well_log', { db: fakeDb });
        expect(cat.promotedColumns).toEqual(expect.arrayContaining(['county', 'depth_bottom', 'event_date', 'latitude']));
    });
});
