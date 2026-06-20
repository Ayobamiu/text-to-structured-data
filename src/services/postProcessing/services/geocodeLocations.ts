/**
 * geocode_locations — derive a coordinate + precision tier for a record, writing
 * to the record_geocodes side table (the record itself stays untouched).
 *
 * Strategy, in priority (each tagged with a precision tier):
 *   1. document lat/long present            → exact         (provider: document)
 *   2. a real street address extractable    → Google        → exact/good (ROOFTOP/RANGE)
 *   3. PLSS township/range/section          → Wellogic section centroid → plss_centroid (~0.2–0.5 mi)
 *   4. a weak Google hit (city/road centroid) and no PLSS → approx (needs_review)
 *   5. nothing usable                       → unresolved (needs_review)
 *
 * The misparse guard (extractStreetAddress) keeps narrative text out of Google.
 */

import {
    extractStreetAddress,
    normalizePlss,
    tierForLocationType,
    googleGeocode as defaultGoogleGeocode,
    wellogicSectionCentroid as defaultWellogicCentroid,
    type GoogleGeocodeResult,
    type SectionCentroid,
} from './geocode/providers.ts';
import type { PostProcessingService, RunArgs, RunResult, SideEffect } from '../types.ts';

export const GEOCODER_VERSION = '1.0.0';

interface GeocodeDeps {
    googleApiKey?: string;
    googleGeocode?: typeof defaultGoogleGeocode;
    wellogicSectionCentroid?: typeof defaultWellogicCentroid;
}

const toNum = (v: unknown): number | null => {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : null;
};
const toStr = (v: unknown): string | null => {
    if (typeof v === 'string' && v.trim()) return v.trim();
    return null;
};

/** Memoized (per run) Wellogic section centroid; tracks whether freshly computed. */
async function getSectionCentroid(
    town: string,
    range: string,
    section: number,
    cache: Map<string, unknown>,
    wellogic: typeof defaultWellogicCentroid,
): Promise<{ centroid: SectionCentroid | null; fresh: boolean }> {
    const key = `plss:${town}|${range}|${section}`;
    if (cache.has(key)) {
        return { centroid: cache.get(key) as SectionCentroid | null, fresh: false };
    }
    const centroid = await wellogic(town, range, section);
    cache.set(key, centroid);
    return { centroid, fresh: true };
}

const geocodeLocations: PostProcessingService = {
    name: 'geocode_locations',
    version: GEOCODER_VERSION,
    appliesTo: (slug) => slug === 'borehole_log' || slug === 'mgs_well_log',

    async run({ record, slug, fileId, cache, deps }: RunArgs): Promise<RunResult> {
        const d = deps as GeocodeDeps;
        const google = d.googleGeocode || defaultGoogleGeocode;
        const wellogic = d.wellogicSectionCentroid || defaultWellogicCentroid;
        const apiKey = d.googleApiKey ?? process.env.GOOGLE_PLACES_API_KEY ?? '';

        const si = (record.site_identification as Record<string, unknown>) || {};
        const base = {
            section_result_id: record.section_result_id,
            file_id: fileId,
            slug,
            geocoder_version: GEOCODER_VERSION,
        };
        const geocodeRow = (extra: Record<string, unknown>): SideEffect => ({
            table: 'record_geocodes',
            row: { ...base, ...extra },
        });

        // 1. Explicit document coordinates — ground truth.
        const lat = toNum(si.latitude_dd);
        const lng = toNum(si.longitude_dd);
        if (lat !== null && lng !== null) {
            return {
                status: 'applied',
                detail: 'document coords',
                sideEffects: [geocodeRow({
                    latitude: lat, longitude: lng, precision_tier: 'exact',
                    strategy: 'document', provider: 'document', needs_review: false,
                })],
            };
        }

        // 2. Extract a real street address and geocode it.
        let weak: { g: GoogleGeocodeResult; query: string } | null = null;
        const street = extractStreetAddress(si.site_address);
        if (street) {
            const query = [street, toStr(si.county) ? `${toStr(si.county)} County` : null, toStr(si.state) || 'MI', 'USA']
                .filter(Boolean).join(', ');
            const g = await google(query, apiKey);
            if (g) {
                const tier = tierForLocationType(g.locationType);
                if (tier === 'exact' || tier === 'good') {
                    return {
                        status: 'applied',
                        detail: g.locationType,
                        sideEffects: [geocodeRow({
                            latitude: g.lat, longitude: g.lng, precision_tier: tier,
                            strategy: tier === 'exact' ? 'address_rooftop' : 'address_interp',
                            provider: 'google', provider_location_type: g.locationType,
                            source_query: query, raw_response: g.raw, needs_review: false,
                        })],
                    };
                }
                weak = { g, query }; // city/road centroid — prefer PLSS if available
            }
        }

        // 3. PLSS section centroid from Wellogic (normalize town/range to Wellogic's
        //    zero-padded form, e.g. "8N" → "08N").
        const townRaw = toStr(si.township);
        const rangeRaw = toStr(si.range);
        const section = toNum(si.section);
        const town = townRaw ? normalizePlss(townRaw) : null;
        const range = rangeRaw ? normalizePlss(rangeRaw) : null;
        if (town && range && section !== null) {
            const { centroid, fresh } = await getSectionCentroid(town, range, Math.trunc(section), cache, wellogic);
            if (centroid) {
                const sideEffects: SideEffect[] = [geocodeRow({
                    latitude: centroid.lat, longitude: centroid.lng, precision_tier: 'plss_centroid',
                    strategy: 'plss_centroid', provider: 'wellogic_plss',
                    source_query: `${town} ${range} ${Math.trunc(section)}`,
                    confidence: centroid.nWells, needs_review: true,
                })];
                if (fresh) {
                    sideEffects.push({
                        table: 'plss_section_centroids',
                        row: { town, range, section: Math.trunc(section), latitude: centroid.lat, longitude: centroid.lng, n_wells: centroid.nWells, source: 'wellogic' },
                    });
                }
                return { status: 'applied', detail: `plss ${town}/${range}/${Math.trunc(section)} (${centroid.nWells} wells)`, sideEffects };
            }
        }

        // 4. Weak Google result (city/road centroid) as a last resort.
        if (weak) {
            return {
                status: 'applied',
                detail: `approx ${weak.g.locationType}`,
                sideEffects: [geocodeRow({
                    latitude: weak.g.lat, longitude: weak.g.lng, precision_tier: 'approx',
                    strategy: 'address_approx', provider: 'google', provider_location_type: weak.g.locationType,
                    source_query: weak.query, raw_response: weak.g.raw, needs_review: true,
                })],
            };
        }

        // 5. Unresolved.
        return {
            status: 'skipped',
            detail: 'unresolved',
            sideEffects: [geocodeRow({ precision_tier: 'unresolved', strategy: 'none', needs_review: true })],
        };
    },
};

export default geocodeLocations;
