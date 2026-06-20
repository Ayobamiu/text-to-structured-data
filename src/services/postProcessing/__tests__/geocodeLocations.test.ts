import { describe, it, expect, vi } from 'vitest';
import geocodeLocations from '../services/geocodeLocations.ts';
import { extractStreetAddress, normalizePlss, tierForLocationType } from '../services/geocode/providers.ts';
import type { RecordObject, RunArgs, SideEffect } from '../types.ts';

// ── the misparse guard ──────────────────────────────────────────────────────
describe('extractStreetAddress (misparse guard)', () => {
    it('keeps a leading house-number address as the whole query', () => {
        expect(extractStreetAddress('11731 40th Ave., Allendale')).toBe('11731 40th Ave., Allendale');
        expect(extractStreetAddress('10760 52nd Street, Allendale, Michigan')).toBe('10760 52nd Street, Allendale, Michigan');
        // a real address with no street-type suffix (BUTTERNUT) must still pass
        expect(extractStreetAddress('426 BUTTERNUT, HOLLAND, MICHIGAN')).toBe('426 BUTTERNUT, HOLLAND, MICHIGAN');
    });

    it('extracts an address embedded on a later line', () => {
        expect(extractStreetAddress('Approx 3/4 mi. n. of M45 on W. side of 40th\n11731 40th Ave.\nAllendale'))
            .toBe('11731 40th Ave');
    });

    it('rejects surveyor narrative (no real house-number address)', () => {
        expect(extractStreetAddress("100' South of N P/L of Able Sanitation, City of Wyoming, Thornwood Dr to private Drive, West")).toBeNull();
        expect(extractStreetAddress('About 0.6 Mi. East of 76th & Arthur Then about 150\' North of Arthur')).toBeNull();
        expect(extractStreetAddress("About 0.2 Miles South of Quincy and About 75' East of 96th Ave")).toBeNull();
        expect(extractStreetAddress('150 feet North of the barn')).toBeNull(); // unit word after number
        expect(extractStreetAddress('')).toBeNull();
        expect(extractStreetAddress(null)).toBeNull();
    });
});

describe('normalizePlss', () => {
    it('zero-pads to Wellogic format', () => {
        expect(normalizePlss('8N')).toBe('08N');
        expect(normalizePlss('7N')).toBe('07N');
        expect(normalizePlss('9w')).toBe('09W');
        expect(normalizePlss('05N')).toBe('05N');
        expect(normalizePlss('16W')).toBe('16W');
    });
});

describe('tierForLocationType', () => {
    it('maps Google location types to precision tiers', () => {
        expect(tierForLocationType('ROOFTOP')).toBe('exact');
        expect(tierForLocationType('RANGE_INTERPOLATED')).toBe('good');
        expect(tierForLocationType('GEOMETRIC_CENTER')).toBe('approx');
        expect(tierForLocationType('APPROXIMATE')).toBe('approx');
    });
});

// ── strategy selection ──────────────────────────────────────────────────────
const args = (record: RecordObject, deps: Record<string, unknown>, cache = new Map<string, unknown>()): RunArgs => ({
    record, slug: 'borehole_log', fileId: 'f1', options: {}, cache, deps,
});
const si = (fields: Record<string, unknown>): RecordObject => ({ section_result_id: 's1', site_identification: fields });
const geocodeOf = (sideEffects: SideEffect[] | undefined) =>
    (sideEffects || []).find((s) => s.table === 'record_geocodes')?.row as Record<string, unknown>;

describe('geocode_locations strategy', () => {
    it('uses document coordinates as exact, calling no providers', async () => {
        const google = vi.fn(); const wellogic = vi.fn();
        const out = await geocodeLocations.run(args(si({ latitude_dd: 42.8, longitude_dd: -86.1 }), { googleGeocode: google, wellogicSectionCentroid: wellogic }));
        expect(out.status).toBe('applied');
        expect(geocodeOf(out.sideEffects)).toMatchObject({ precision_tier: 'exact', strategy: 'document', provider: 'document' });
        expect(google).not.toHaveBeenCalled();
        expect(wellogic).not.toHaveBeenCalled();
    });

    it('geocodes a real street address to ROOFTOP=exact', async () => {
        const google = vi.fn(async () => ({ lat: 42.98, lng: -85.88, locationType: 'ROOFTOP', formattedAddress: '11731 40th Ave', raw: {} }));
        const wellogic = vi.fn();
        const out = await geocodeLocations.run(args(si({ site_address: '11731 40th Ave, Allendale', county: 'Ottawa', state: 'MI' }), { googleGeocode: google, wellogicSectionCentroid: wellogic, googleApiKey: 'k' }));
        expect(geocodeOf(out.sideEffects)).toMatchObject({ precision_tier: 'exact', strategy: 'address_rooftop', provider: 'google' });
        expect(google).toHaveBeenCalledOnce();
        expect(wellogic).not.toHaveBeenCalled();
    });

    it('NEVER sends narrative text to Google; falls to PLSS centroid', async () => {
        const google = vi.fn();
        const wellogic = vi.fn(async () => ({ lat: 42.81, lng: -86.13, nWells: 25 }));
        const out = await geocodeLocations.run(args(
            si({ site_address: "About 0.2 Miles South of Quincy and About 75' East of 96th Ave", township: '05N', range: '15W', section: '18' }),
            { googleGeocode: google, wellogicSectionCentroid: wellogic, googleApiKey: 'k' },
        ));
        expect(google).not.toHaveBeenCalled(); // the guard
        expect(geocodeOf(out.sideEffects)).toMatchObject({ precision_tier: 'plss_centroid', strategy: 'plss_centroid', provider: 'wellogic_plss', needs_review: true });
        // emits a plss cache row the first time
        expect((out.sideEffects || []).some((s) => s.table === 'plss_section_centroids')).toBe(true);
    });

    it('prefers PLSS over a weak (city-centroid) Google hit', async () => {
        const google = vi.fn(async () => ({ lat: 42.9, lng: -85.7, locationType: 'APPROXIMATE', formattedAddress: 'Wyoming, MI', raw: {} }));
        const wellogic = vi.fn(async () => ({ lat: 42.81, lng: -86.13, nWells: 12 }));
        const out = await geocodeLocations.run(args(
            si({ site_address: '11731 40th Ave', township: '05N', range: '15W', section: '18' }),
            { googleGeocode: google, wellogicSectionCentroid: wellogic, googleApiKey: 'k' },
        ));
        expect(google).toHaveBeenCalledOnce();
        expect(geocodeOf(out.sideEffects)).toMatchObject({ precision_tier: 'plss_centroid' });
    });

    it('falls back to a weak Google hit as approx when no PLSS', async () => {
        const google = vi.fn(async () => ({ lat: 42.9, lng: -85.7, locationType: 'GEOMETRIC_CENTER', formattedAddress: '48th Ave', raw: {} }));
        const out = await geocodeLocations.run(args(si({ site_address: '100 48th Ave' }), { googleGeocode: google, wellogicSectionCentroid: vi.fn(), googleApiKey: 'k' }));
        expect(geocodeOf(out.sideEffects)).toMatchObject({ precision_tier: 'approx', strategy: 'address_approx', needs_review: true });
    });

    it('marks unresolved when nothing is usable', async () => {
        const out = await geocodeLocations.run(args(si({ county: 'Ottawa' }), { googleGeocode: vi.fn(), wellogicSectionCentroid: vi.fn() }));
        expect(out.status).toBe('skipped');
        expect(geocodeOf(out.sideEffects)).toMatchObject({ precision_tier: 'unresolved', strategy: 'none' });
    });

    it('memoizes the section centroid across records in a run', async () => {
        const wellogic = vi.fn(async () => ({ lat: 42.81, lng: -86.13, nWells: 25 }));
        const cache = new Map<string, unknown>();
        const deps = { googleGeocode: vi.fn(), wellogicSectionCentroid: wellogic, googleApiKey: 'k' };
        const r1 = await geocodeLocations.run(args(si({ township: '05N', range: '15W', section: '18' }), deps, cache));
        const r2 = await geocodeLocations.run(args({ ...si({ township: '05N', range: '15W', section: '18' }), section_result_id: 's2' }, deps, cache));
        expect(wellogic).toHaveBeenCalledOnce();
        // plss cache row emitted only on the fresh (first) computation
        expect((r1.sideEffects || []).some((s) => s.table === 'plss_section_centroids')).toBe(true);
        expect((r2.sideEffects || []).some((s) => s.table === 'plss_section_centroids')).toBe(false);
    });

    it('normalizes township/range to Wellogic format before querying', async () => {
        const wellogic = vi.fn(async () => ({ lat: 43.03, lng: -86.21, nWells: 34 }));
        await geocodeLocations.run(args(si({ township: '8N', range: '16W', section: '33' }), { googleGeocode: vi.fn(), wellogicSectionCentroid: wellogic }));
        expect(wellogic).toHaveBeenCalledWith('08N', '16W', 33);
    });

    it('only applies to well-log slugs', () => {
        expect(geocodeLocations.appliesTo!('borehole_log')).toBe(true);
        expect(geocodeLocations.appliesTo!('mgs_well_log')).toBe(true);
        expect(geocodeLocations.appliesTo!('aquifer_test')).toBe(false);
    });
});
