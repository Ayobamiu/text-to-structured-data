import { describe, it, expect, beforeEach } from 'vitest';
import { runServices } from '../runner.ts';
import { registerService, getService, listServices, _resetRegistry } from '../registry.ts';
import mgsEnrich from '../services/mgsEnrich.ts';
import type { PostProcessingService, RecordObject } from '../types.ts';

const rec = (over: Partial<RecordObject> = {}): RecordObject => ({
    section_result_id: 's1',
    slug: 'borehole_log',
    ...over,
});

describe('post-processing runner', () => {
    it('runs services in the given order', async () => {
        const calls: string[] = [];
        const a: PostProcessingService = { name: 'a', version: '1', appliesTo: () => true, run: async () => { calls.push('a'); return { status: 'applied' }; } };
        const b: PostProcessingService = { name: 'b', version: '1', appliesTo: () => true, run: async () => { calls.push('b'); return { status: 'applied' }; } };
        await runServices({ records: [rec()], services: [a, b] });
        expect(calls).toEqual(['a', 'b']);
    });

    it('skips a service that does not apply to the slug', async () => {
        const onlyAquifer: PostProcessingService = {
            name: 'aq', version: '1',
            appliesTo: (slug) => slug === 'aquifer_test',
            run: async () => ({ status: 'applied' }),
        };
        const { records, summary } = await runServices({ records: [rec()], services: [onlyAquifer] });
        expect(summary.aq.skipped).toBe(1);
        expect(summary.aq.applied).toBe(0);
        expect(records[0].extraction_metadata?.post_processing ?? []).toHaveLength(0);
    });

    it('stamps provenance with name, version and status', async () => {
        const svc: PostProcessingService = { name: 'geo', version: '2.1', appliesTo: () => true, run: async () => ({ status: 'applied', detail: 'ROOFTOP' }) };
        const { records } = await runServices({ records: [rec()], services: [svc] });
        const prov = records[0].extraction_metadata!.post_processing!;
        expect(prov).toHaveLength(1);
        expect(prov[0]).toMatchObject({ name: 'geo', version: '2.1', status: 'applied', detail: 'ROOFTOP' });
        expect(typeof prov[0].at).toBe('string');
    });

    it('is idempotent: a second run skips already-applied services', async () => {
        let runCount = 0;
        const svc: PostProcessingService = { name: 'geo', version: '1', appliesTo: () => true, run: async () => { runCount++; return { status: 'applied' }; } };
        const first = await runServices({ records: [rec()], services: [svc] });
        const second = await runServices({ records: first.records, services: [svc] });
        expect(runCount).toBe(1);
        expect(second.summary.geo.skipped).toBe(1);
        expect(first.records[0].extraction_metadata!.post_processing).toHaveLength(1);
    });

    it('re-runs when force=true or version changes', async () => {
        let runCount = 0;
        const v1: PostProcessingService = { name: 'geo', version: '1', appliesTo: () => true, run: async () => { runCount++; return { status: 'applied' }; } };
        const first = await runServices({ records: [rec()], services: [v1] });
        await runServices({ records: first.records, services: [v1], force: true });
        const v2: PostProcessingService = { ...v1, version: '2' };
        await runServices({ records: first.records, services: [v2] });
        expect(runCount).toBe(3);
    });

    it('collects side effects without writing them', async () => {
        const geocoder: PostProcessingService = {
            name: 'geo', version: '1', appliesTo: () => true,
            run: async ({ record }) => ({
                status: 'applied',
                sideEffects: [{ table: 'record_geocodes', row: { section_result_id: record.section_result_id, latitude: 42.1, longitude: -86.2 } }],
            }),
        };
        const { sideEffects } = await runServices({ records: [rec(), rec({ section_result_id: 's2' })], services: [geocoder] });
        expect(sideEffects).toHaveLength(2);
        expect(sideEffects[0]).toMatchObject({ table: 'record_geocodes', row: { section_result_id: 's1' } });
    });

    it('memoizes lookups across records via the shared cache', async () => {
        let lookups = 0;
        const svc: PostProcessingService = {
            name: 'lk', version: '1', appliesTo: () => true,
            run: async ({ cache }) => {
                if (cache.get('k') === undefined) { lookups++; cache.set('k', 'v'); }
                return { status: 'applied' };
            },
        };
        await runServices({ records: [rec(), rec({ section_result_id: 's2' }), rec({ section_result_id: 's3' })], services: [svc] });
        expect(lookups).toBe(1);
    });

    it('isolates a throwing service: records it as error and continues', async () => {
        const boom: PostProcessingService = { name: 'boom', version: '1', appliesTo: () => true, run: async () => { throw new Error('kaboom'); } };
        const ok: PostProcessingService = { name: 'ok', version: '1', appliesTo: () => true, run: async () => ({ status: 'applied' }) };
        const { records, summary } = await runServices({ records: [rec()], services: [boom, ok] });
        expect(summary.boom.error).toBe(1);
        expect(summary.ok.applied).toBe(1);
        const prov = records[0].extraction_metadata!.post_processing!;
        expect(prov.find((p) => p.name === 'boom')).toMatchObject({ status: 'error', detail: 'kaboom' });
    });

    it('does not mutate the input record', async () => {
        const input = rec();
        const svc: PostProcessingService = { name: 'geo', version: '1', appliesTo: () => true, run: async ({ record }) => ({ record: { ...record, extra: 1 }, status: 'applied' }) };
        await runServices({ records: [input], services: [svc] });
        expect((input as Record<string, unknown>).extra).toBeUndefined();
        expect(input.extraction_metadata).toBeUndefined();
    });
});

describe('registry', () => {
    beforeEach(() => _resetRegistry());

    it('registers and retrieves services', () => {
        registerService(mgsEnrich);
        expect(getService('mgs_enrich')).toBe(mgsEnrich);
        expect(listServices()).toHaveLength(1);
    });

    it('rejects duplicates and malformed services', () => {
        registerService({ name: 'x', version: '1', run: async () => ({ status: 'applied' }) });
        expect(() => registerService({ name: 'x', version: '1', run: async () => ({ status: 'applied' }) })).toThrow(/duplicate/);
        // @ts-expect-error missing version
        expect(() => registerService({ name: 'y', run: async () => ({ status: 'applied' }) })).toThrow(/version/);
        // @ts-expect-error missing run
        expect(() => registerService({ name: 'z', version: '1' })).toThrow(/run/);
    });
});

describe('mgs_enrich service', () => {
    it('skips when no permit_number', async () => {
        const out = await mgsEnrich.run({ record: rec(), cache: new Map(), deps: {}, slug: 'borehole_log', fileId: null, options: {} });
        expect(out.status).toBe('skipped');
    });

    it('merges MGS data and memoizes the lookup per permit', async () => {
        let lookups = 0;
        const fake = {
            getMGSDataByPermitNumber: async (p: string) => { lookups++; return { county: 'Kent', permit: p }; },
            mergeMGSData: (record: Record<string, unknown>, data: Record<string, unknown>) => ({ ...record, mgs_county: data.county }),
        };
        const cache = new Map<string, unknown>();
        const base = { slug: 'borehole_log', fileId: null, options: {}, deps: { mgsDataService: fake } } as const;
        const r1 = await mgsEnrich.run({ ...base, record: rec({ permit_number: '123' }), cache });
        const r2 = await mgsEnrich.run({ ...base, record: rec({ section_result_id: 's2', permit_number: '123' }), cache });
        expect((r1.record as Record<string, unknown>).mgs_county).toBe('Kent');
        expect((r2.record as Record<string, unknown>).mgs_county).toBe('Kent');
        expect(lookups).toBe(1);
    });
});
