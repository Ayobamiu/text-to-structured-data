/**
 * Geocoding providers + the narrative-address guard.
 *
 * The "address" field in our data is mostly surveyor narrative ("100' South of
 * N P/L of Able Sanitation…", "0.2 Mi South of Quincy & 75' East of 96th Ave"),
 * not street addresses. Google always returns *something* and can misparse
 * narrative into a confident-but-wrong rooftop. So we only send Google a string
 * we can extract a real house-number street address from; everything else falls
 * to the PLSS section centroid.
 */

const STREET_SUFFIX =
    '(?:Ave|Avenue|St|Street|Rd|Road|Dr|Drive|Ln|Lane|Blvd|Boulevard|Hwy|Highway|Ct|Court|Way|Pl|Place|Cir|Circle|Ter|Terrace|Pkwy|Parkway)';

// An embedded "house# streetname suffix" — for addresses buried mid-text, e.g.
// "Approx 3/4 mi n of M45\n11731 40th Ave\nAllendale". Requires whitespace after
// the house number, so "100'" (feet) and "96th" (a street name) never qualify.
const STREET_RE = new RegExp(
    String.raw`\b\d{2,6}\s+(?:[NSEW]\.?\s+)?[A-Za-z0-9][\w.'-]*(?:\s+[A-Za-z0-9][\w.'-]*){0,3}\s+${STREET_SUFFIX}\b\.?`,
    'i',
);

// A leading house-number address ("426 BUTTERNUT, HOLLAND" / "10760 52nd Street")
// where the token after the number is NOT a distance/direction unit — that's how
// we tell a real address from narrative like "100' South…" or "150 feet North…".
// Street names can start with a digit ("40th", "52nd"), so allow [A-Za-z0-9]
// after the house number — but reject distance/direction units.
const UNITS = '(?:feet|foot|ft|mi|miles?|yards?|north|south|east|west|n|s|e|w)';
const LEADING_ADDR_RE = new RegExp(String.raw`^\d{1,6}\s+(?!${UNITS}\b)[A-Za-z0-9]`, 'i');

/**
 * Extract a clean street-address candidate from free text, or null if the text
 * is narrative-only (so narrative never reaches Google, which would misparse it).
 */
export function extractStreetAddress(text: unknown): string | null {
    if (typeof text !== 'string' || !text.trim()) return null;
    const oneLine = text.replace(/\s+/g, ' ').trim();
    // (a) starts with a real house-number address → use the whole string.
    if (LEADING_ADDR_RE.test(oneLine)) return oneLine;
    // (b) a street address embedded later in the text.
    const m = STREET_RE.exec(oneLine);
    if (m) return m[0].replace(/[.,\s]+$/, '').trim();
    return null;
}

/**
 * Normalize a PLSS town/range token to Michigan Wellogic's zero-padded form:
 * "8N" → "08N", "9W" → "09W", "05N" → "05N". Leaves unrecognized values upper-cased.
 */
export function normalizePlss(value: string): string {
    const m = /^\s*(\d{1,3})\s*([NSEW])\s*$/i.exec(value);
    if (!m) return value.trim().toUpperCase();
    return m[1].padStart(2, '0') + m[2].toUpperCase();
}

export type PrecisionTier = 'exact' | 'good' | 'approx' | 'plss_centroid' | 'unresolved';

/** Map a Google location_type to our precision tier. */
export function tierForLocationType(locationType: string): PrecisionTier {
    switch (locationType) {
        case 'ROOFTOP':
            return 'exact';
        case 'RANGE_INTERPOLATED':
            return 'good';
        default: // GEOMETRIC_CENTER, APPROXIMATE
            return 'approx';
    }
}

export interface GoogleGeocodeResult {
    lat: number;
    lng: number;
    locationType: string;
    formattedAddress: string;
    raw: unknown;
}

/** Call the Google Geocoding API. Returns null on no result; throws on transport/denied. */
export async function googleGeocode(
    query: string,
    apiKey: string,
    fetchImpl: typeof fetch = fetch,
): Promise<GoogleGeocodeResult | null> {
    if (!apiKey) throw new Error('googleGeocode: missing API key');
    const url =
        'https://maps.googleapis.com/maps/api/geocode/json?' +
        new URLSearchParams({ address: query, key: apiKey }).toString();
    const res = await fetchImpl(url);
    const data: any = await res.json();
    if (data.status === 'OK' && Array.isArray(data.results) && data.results.length > 0) {
        const r = data.results[0];
        return {
            lat: r.geometry.location.lat,
            lng: r.geometry.location.lng,
            locationType: r.geometry.location_type,
            formattedAddress: r.formatted_address,
            raw: r,
        };
    }
    if (data.status === 'ZERO_RESULTS') return null;
    throw new Error(`googleGeocode: ${data.status}${data.error_message ? ` — ${data.error_message}` : ''}`);
}

export interface AddressParts {
    county: string | null;
    township: string | null; // civil township name (Wellogic TOWNSHIP), not PLSS TOWN
    city: string | null;
    state: string | null;
    postalCode: string | null;
}

/**
 * Pull county/township/city/state/zip out of a Google result's address_components
 * so we don't waste the data the geocode already returned. County's " County"
 * suffix is stripped to match Wellogic's bare county names ("Ottawa County" → "Ottawa").
 */
export function parseAddressComponents(raw: unknown): AddressParts {
    const comps: any[] = (raw as any)?.address_components || [];
    const pick = (type: string, field: 'long_name' | 'short_name' = 'long_name'): string | null => {
        const c = comps.find((x) => Array.isArray(x?.types) && x.types.includes(type));
        const v = c ? c[field] : null;
        return typeof v === 'string' && v.trim() ? v.trim() : null;
    };
    const county = pick('administrative_area_level_2');
    return {
        county: county ? county.replace(/\s+County$/i, '').trim() : null,
        township: pick('administrative_area_level_3'),
        city: pick('locality'),
        state: pick('administrative_area_level_1', 'short_name'),
        postalCode: pick('postal_code'),
    };
}

export interface SectionCentroid {
    lat: number;
    lng: number;
    nWells: number;
}

/**
 * Derive a PLSS section centroid from Michigan Wellogic wells in that section
 * (TOWN/RANGE/SECTION match our township/range/section exactly). Averages the
 * member wells' coordinates. Returns null when no Wellogic wells exist there.
 */
export async function wellogicSectionCentroid(
    town: string,
    range: string,
    section: number,
    fetchImpl: typeof fetch = fetch,
): Promise<SectionCentroid | null> {
    const where = `TOWN='${town}' AND RANGE='${range}' AND SECTION=${section}`;
    const url =
        'https://gisagoegle.state.mi.us/arcgis/rest/services/EGLE/DwOpenData/MapServer/3/query?' +
        new URLSearchParams({
            where,
            outFields: 'LATITUDE,LONGITUDE',
            returnGeometry: 'false',
            f: 'json',
        }).toString();
    const res = await fetchImpl(url);
    const data: any = await res.json();
    const feats: any[] = Array.isArray(data.features) ? data.features : [];
    const pts = feats
        .map((f) => f.attributes)
        .filter((a) => a && typeof a.LATITUDE === 'number' && typeof a.LONGITUDE === 'number');
    if (pts.length === 0) return null;
    const lat = pts.reduce((s, a) => s + a.LATITUDE, 0) / pts.length;
    const lng = pts.reduce((s, a) => s + a.LONGITUDE, 0) / pts.length;
    return { lat, lng, nWells: pts.length };
}

export default { extractStreetAddress, tierForLocationType, googleGeocode, wellogicSectionCentroid, parseAddressComponents };
