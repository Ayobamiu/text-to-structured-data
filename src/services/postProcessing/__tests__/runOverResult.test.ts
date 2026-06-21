import { describe, it, expect } from 'vitest';
import { runConfiguredServicesOverResult } from '../runOverResult.ts';
import type { PostProcessingService } from '../types.ts';

/** A service that stamps `geo: true` on the record and emits a geocode side effect. */
const geocode: PostProcessingService = {
    name: 'geocode_locations', version: '1.0.0',
    appliesTo: (slug) => slug === 'borehole_log',
    run: async ({ record }) => ({
        record: { ...record, geo: true },
        status: 'applied',
        sideEffects: [{ table: 'record_geocodes', row: { section_result_id: record.section_result_id, precision_tier: 'exact' } }],
    }),
};
/** A service applicable to all slugs that stamps `mgs: true`. */
const mgs: PostProcessingService = {
    name: 'mgs_enrich', version: '1.0.0', appliesTo: () => true,
    run: async ({ record }) => ({ record: { ...record, mgs: true }, status: 'applied' }),
};
const registry = [geocode, mgs];

describe('runConfiguredServicesOverResult', () => {
    it('runs only the enabled services for each slug, per the slug default', async () => {
        const result = {
            borehole_log: [{ section_result_id: 'a', x: 1 }, { section_result_id: 'b', x: 2 }],
            aquifer_test: [{ section_result_id: 'c', y: 9 }],
        };
        const out = await runConfiguredServicesOverResult({
            result,
            fileId: 'f1',
            slugDefaultsBySlug: { borehole_log: [{ name: 'geocode_locations', enabled: true }] },
            registry,
        });

        const r = out.result as typeof result;
        // borehole_log records geocoded; aquifer_test untouched (no enabled service).
        expect(r.borehole_log[0]).toMatchObject({ geo: true });
        expect(r.borehole_log[1]).toMatchObject({ geo: true });
        expect(r.aquifer_test[0]).not.toHaveProperty('geo');
        expect(out.slugsRun).toEqual(['borehole_log']);
        expect(out.recordsProcessed).toBe(2);
        expect(out.sideEffects).toHaveLength(2);
    });

    it('a service enabled for one slug does NOT run on another slug', async () => {
        const result = {
            borehole_log: [{ section_result_id: 'a', x: 1 }],
            aquifer_test: [{ section_result_id: 'c', y: 9 }],
        };
        // mgs_enrich applies to all slugs but is only enabled (via default) for borehole_log.
        const out = await runConfiguredServicesOverResult({
            result,
            fileId: 'f1',
            slugDefaultsBySlug: { borehole_log: [{ name: 'mgs_enrich', enabled: true }] },
            registry,
        });
        const r = out.result as typeof result;
        expect(r.borehole_log[0]).toMatchObject({ mgs: true });
        expect(r.aquifer_test[0]).not.toHaveProperty('mgs');
    });

    it('job override turns the slug default off → no services run', async () => {
        const result = { borehole_log: [{ section_result_id: 'a', x: 1 }] };
        const out = await runConfiguredServicesOverResult({
            result,
            fileId: 'f1',
            slugDefaultsBySlug: { borehole_log: [{ name: 'geocode_locations', enabled: true }] },
            jobOverrides: [{ name: 'geocode_locations', enabled: false }],
            registry,
        });
        expect(out.slugsRun).toHaveLength(0);
        expect(out.sideEffects).toHaveLength(0);
        expect(out.result).toBe(result); // unchanged reference when nothing ran
    });

    it('does not mutate the input envelope', async () => {
        const result = { borehole_log: [{ section_result_id: 'a', x: 1 }] };
        await runConfiguredServicesOverResult({
            result,
            fileId: 'f1',
            slugDefaultsBySlug: { borehole_log: [{ name: 'geocode_locations', enabled: true }] },
            registry,
        });
        expect(result.borehole_log[0]).not.toHaveProperty('geo');
    });
});
