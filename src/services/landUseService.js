import https from 'https';

/**
 * Land Use Service - Get surface land use type from coordinates
 * Uses OSM Overpass API
 */
class LandUseService {
    constructor() {
    }

    /**
     * Get land use type for given coordinates
     * @param {number} lat - Latitude
     * @param {number} lng - Longitude
     * @returns {Promise<string>} Land use type
     */
    async getLandUseType(lat, lng) {
        console.log(`🌍 Getting land use data for coordinates: ${lat}, ${lng}`);
        try {
            // Try OSM Overpass API first
            const osmResult = await this.tryOverpassAPI(lat, lng);

            if (osmResult && osmResult.landUseType && osmResult.landUseType !== 'Unknown') {
                return osmResult.landUseType;
            }
            return null;
        } catch (error) {
            console.log(`❌ Error getting land use data: ${error.message}`);
            return null;
        }
    }

    /**
     * Try OSM Overpass API using the working classifyLandUse.js approach
     * @param {number} lat - Latitude
     * @param {number} lng - Longitude
     * @returns {Promise<Object|null>} OSM land use data or null
     */
    async tryOverpassAPI(lat, lng) {
        return new Promise((resolve) => {
            // Use the working classifyLandUse.js query
            const query = `
[out:json][timeout:25];
(
  way(around:1000,${lat},${lng})[landuse];
  rel(around:1000,${lat},${lng})[landuse];

  way(around:1000,${lat},${lng})[leisure];
  rel(around:1000,${lat},${lng})[leisure];

  way(around:1000,${lat},${lng})[natural][natural!="tree"];
  rel(around:1000,${lat},${lng})[natural][natural!="tree"];
  way(around:1000,${lat},${lng})[natural=tree_row];

  way(around:1000,${lat},${lng})[boundary=protected_area];
  rel(around:1000,${lat},${lng})[boundary=protected_area];

  way(around:1000,${lat},${lng})[building];
  way(around:1000,${lat},${lng})[amenity=parking];
  way(around:1000,${lat},${lng})[highway];
  way(around:1000,${lat},${lng})[aeroway];
);
out tags center bb;
`;

            const url = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`;

            const request = https.get(url, (response) => {
                let data = '';

                response.on('data', (chunk) => {
                    data += chunk;
                });

                response.on('end', () => {
                    try {
                        const result = JSON.parse(data);

                        if (result.elements && result.elements.length > 0) {
                            // Use the same logic as classifyLandUse.js
                            const landUseType = this.classifyLandUseFromOSM(result.elements, lat, lng);

                            if (landUseType && landUseType !== 'Unknown') {
                                resolve({
                                    landUseType,
                                    osmLandUse: 'classified',
                                    source: 'OSM_Overpass',
                                    distance: 0
                                });
                            } else {
                                resolve(null);
                            }
                        } else {
                            resolve(null);
                        }
                    } catch (parseError) {
                        console.log('OSM Overpass API response parse error:', parseError.message);
                        resolve(null);
                    }
                });
            });

            request.on('error', (error) => {
                console.log('OSM Overpass API request error:', error.message);
                resolve(null);
            });

            request.setTimeout(10000, () => {
                request.destroy();
                resolve(null);
            });
        });
    }

    /**
     * Classify land use from OSM elements using classifyLandUse.js logic
     * @param {Array} elements - OSM elements
     * @param {number} lat - Latitude
     * @param {number} lng - Longitude
     * @returns {string} Land use type
     */
    classifyLandUseFromOSM(elements, lat, lng) {
        const landUseMap = {
            // landuse=*
            residential: 'Residential',
            commercial: 'Commercial',
            retail: 'Commercial',
            industrial: 'Industrial',
            railway: 'Transportation',
            road: 'Transportation',
            construction: 'Industrial',
            farmland: 'Agricultural',
            farmyard: 'Agricultural',
            orchard: 'Agricultural',
            vineyard: 'Agricultural',
            forest: 'Forest',
            meadow: 'Agricultural',
            grass: 'Public/Open',
            cemetery: 'Public/Open',
            recreation_ground: 'Public/Open',
            quarry: 'Industrial',

            // leisure=*
            park: 'Public/Open',
            garden: 'Public/Open',
            pitch: 'Public/Open',
            golf_course: 'Public/Open',
            nature_reserve: 'Protected',

            // natural=*
            wood: 'Forest',
            scrub: 'Forest',
            heath: 'Public/Open',
            grassland: 'Public/Open',
            beach: 'Public/Open',
            water: 'Water/Wetland',
            wetland: 'Water/Wetland',
            coastline: 'Water/Wetland',

            // boundary=*
            protected_area: 'Protected',

            // building=*
            office: 'Commercial',
            retail_building: 'Commercial',
            industrial_building: 'Industrial',
            residential_building: 'Residential',
            commercial_building: 'Commercial',
            apartments: 'Residential',
            house: 'Residential',
            warehouse: 'Industrial',

            // highway / aeroway / amenity
            highway: 'Transportation',
            aeroway: 'Transportation',
            parking: 'Transportation'
        };

        function normalizeTag(tags = {}) {
            const t =
                tags.landuse ||
                tags.leisure ||
                tags.natural ||
                tags.boundary ||
                (tags.amenity === "parking" ? "parking" : "") ||
                (tags.highway ? "highway" : "") ||
                (tags.aeroway ? "aeroway" : "") ||
                "";

            let key = String(t).toLowerCase();

            if (!key && tags.building) {
                const b = String(tags.building).toLowerCase();
                if (/(office|commercial)/.test(b)) key = "commercial_building";
                else if (/(apartments|residential|house)/.test(b)) key = "residential_building";
                else if (/(warehouse|industrial)/.test(b)) key = "industrial_building";
            }

            return key;
        }

        function toEnumFromTags(tags = {}) {
            const key = normalizeTag(tags);
            if (key && key in landUseMap) return landUseMap[key];

            const all = JSON.stringify(tags).toLowerCase();
            if (/retail|shop/.test(all)) return 'Commercial';
            if (/rail|transit|transport/.test(all)) return 'Transportation';
            if (/park|recreation|golf|garden/.test(all)) return 'Public/Open';
            if (/forest|wood|scrub/.test(all)) return 'Forest';
            if (/wetland|water|reservoir|river|bay|lagoon/.test(all)) return 'Water/Wetland';
            if (/nature_reserve|protected/.test(all)) return 'Protected';

            return "Unknown";
        }

        function distanceMeters(lat1, lon1, lat2, lon2) {
            const R = 6371000;
            const toRad = (d) => (d * Math.PI) / 180;
            const dLat = toRad(lat2 - lat1);
            const dLon = toRad(lon2 - lon1);
            const a =
                Math.sin(dLat / 2) ** 2 +
                Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
            return 2 * R * Math.asin(Math.sqrt(a));
        }

        function centerFromBounds(bounds) {
            if (!bounds) return null;
            const lat = (bounds.minlat + bounds.maxlat) / 2;
            const lon = (bounds.minlon + bounds.maxlon) / 2;
            if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon };
            return null;
        }

        // Filter and process elements
        const polys = elements
            .filter((e) => e.type === "way" || e.type === "relation")
            .map((e) => {
                const center = e.center || centerFromBounds(e.bounds);
                return center ? { ...e, center } : null;
            })
            .filter(Boolean);

        if (polys.length === 0) return "Unknown";

        // Rank by distance and classify
        polys.forEach((e) => {
            e._dist = distanceMeters(lat, lng, e.center.lat, e.center.lon);
            e._enum = toEnumFromTags(e.tags);
        });
        polys.sort((a, b) => a._dist - b._dist);

        // Find best result
        const BEST_MAX_METERS = Math.max(150, Math.min(800, 1000));
        const best =
            polys.find((e) => e._enum !== "Unknown" && e._dist <= BEST_MAX_METERS) ||
            polys.find((e) => e._enum !== "Unknown") ||
            polys[0];

        return best._enum || "Unknown";
    }
}

export default new LandUseService();
