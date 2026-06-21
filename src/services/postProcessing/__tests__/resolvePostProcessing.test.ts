import { describe, it, expect } from 'vitest';
import { resolvePostProcessing } from '../resolvePostProcessing.ts';
import type { PostProcessingService } from '../types.ts';

/** Minimal fake services. run() is never called by the resolver. */
const noop = async () => ({ status: 'skipped' as const });
const geocode: PostProcessingService = {
    name: 'geocode_locations', version: '1.0.0',
    appliesTo: (slug) => slug === 'borehole_log', run: noop,
};
const mgs: PostProcessingService = {
    name: 'mgs_enrich', version: '1.0.0', appliesTo: () => true, run: noop,
};
const registry = [geocode, mgs];

describe('resolvePostProcessing', () => {
    it('enables a service via the slug default', () => {
        const { services } = resolvePostProcessing({
            slug: 'borehole_log',
            slugDefaults: [{ name: 'geocode_locations', enabled: true }],
            registry,
        });
        expect(services.map((s) => s.name)).toEqual(['geocode_locations']);
    });

    it('job override turns OFF a slug default', () => {
        const { services } = resolvePostProcessing({
            slug: 'borehole_log',
            slugDefaults: [{ name: 'geocode_locations', enabled: true }],
            jobOverrides: [{ name: 'geocode_locations', enabled: false }],
            registry,
        });
        expect(services).toHaveLength(0);
    });

    it('job override turns ON a service the slug left off', () => {
        const { services } = resolvePostProcessing({
            slug: 'borehole_log',
            jobOverrides: [{ name: 'mgs_enrich', enabled: true }],
            registry,
        });
        expect(services.map((s) => s.name)).toEqual(['mgs_enrich']);
    });

    it('respects appliesTo — geocode not offered for a non-matching slug', () => {
        const { services } = resolvePostProcessing({
            slug: 'aquifer_test',
            slugDefaults: [{ name: 'geocode_locations', enabled: true }],
            jobOverrides: [{ name: 'geocode_locations', enabled: true }],
            registry,
        });
        expect(services).toHaveLength(0);
    });

    it('defaults to OFF when neither source mentions the service', () => {
        const { services } = resolvePostProcessing({ slug: 'borehole_log', registry });
        expect(services).toHaveLength(0);
    });

    it('merges options (job overrides slug)', () => {
        const { optionsByService } = resolvePostProcessing({
            slug: 'borehole_log',
            slugDefaults: [{ name: 'geocode_locations', enabled: true, options: { a: 1, b: 2 } }],
            jobOverrides: [{ name: 'geocode_locations', enabled: true, options: { b: 3 } }],
            registry,
        });
        expect(optionsByService.geocode_locations).toEqual({ a: 1, b: 3 });
    });

    it('preserves registry order', () => {
        const { services } = resolvePostProcessing({
            slug: 'borehole_log',
            slugDefaults: [
                { name: 'mgs_enrich', enabled: true },
                { name: 'geocode_locations', enabled: true },
            ],
            registry,
        });
        expect(services.map((s) => s.name)).toEqual(['geocode_locations', 'mgs_enrich']);
    });
});
