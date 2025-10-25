import fs from 'fs';
import path from 'path';
import csv from 'csv-parser';
import landUseService from './landUseService.js';

class MGSDataService {
    constructor() {
        this.csvPath = path.join(process.cwd(), 'data', 'Appendix 1 - State inventory of Lower Peninsula boreholes(All LP Wells).csv');
        this.dataCache = null;
        this.cacheTimestamp = null;
        this.CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
    }

    /**
     * Load CSV data with caching
     */
    async loadCSVData() {
        const now = Date.now();

        // Return cached data if still valid
        if (this.dataCache && this.cacheTimestamp && (now - this.cacheTimestamp) < this.CACHE_DURATION) {
            return this.dataCache;
        }

        return new Promise((resolve, reject) => {
            const results = [];

            fs.createReadStream(this.csvPath)
                .pipe(csv())
                .on('data', (data) => {
                    results.push(data);
                })
                .on('end', () => {
                    this.dataCache = results;
                    this.cacheTimestamp = now;
                    console.log(`📊 Loaded ${results.length} MGS records from CSV`);
                    resolve(results);
                })
                .on('error', (error) => {
                    console.error('❌ Error reading MGS CSV file:', error);
                    reject(error);
                });
        });
    }

    /**
     * Extract MGS data for a specific permit number
     */
    async getMGSDataByPermitNumber(permitNumber) {
        try {
            const csvData = await this.loadCSVData();

            // Find matching record by permit number
            const matchingRecord = csvData.find(record =>
                record.permit_no && record.permit_no.toString().trim() === permitNumber.toString().trim()
            );

            if (!matchingRecord) {
                return null;
            }

            // If well_no is in the format "alphadigit/alphadigit", convert it to "alphadigit-alphadigit"
            if (matchingRecord.well_no && typeof matchingRecord.well_no === 'string') {
                // Replace any occurrence of "letters-or-digits/letters-or-digits" with "letters-or-digits-letters-or-digits"
                matchingRecord.well_no = matchingRecord.well_no.replace(/^([A-Za-z0-9]+)\s*\/\s*([A-Za-z0-9]+)$/, '$1-$2');
            }
            const measured_depth = matchingRecord.dtd ? parseFloat(matchingRecord.dtd) : null
            // Extract the required fields
            const mgsData = {
                api_number: matchingRecord.api_wellno || null,
                lease_name: matchingRecord.lease_name || null,
                well_number: matchingRecord.well_no || null,
                latitude: matchingRecord.Latitude ? parseFloat(matchingRecord.Latitude) : null,
                longitude: matchingRecord.Longitude ? parseFloat(matchingRecord.Longitude) : null,
                elevation: matchingRecord.elev_ref ? parseFloat(matchingRecord.elev_ref) : null,
                elevation_datum: matchingRecord.ref_tops ? datumMap[matchingRecord.ref_tops] : null, // Based on CSV structure, seems to be 'K' for most records
                well_type: matchingRecord.well_type && wellTypeMap[matchingRecord.well_type] ? wellTypeMap[matchingRecord.well_type] : matchingRecord.well_type || null,
                status: matchingRecord.well_stat || null,
                measured_depth: matchingRecord.dtd ? parseFloat(matchingRecord.dtd) : null,
                true_depth: matchingRecord.tvd ? parseFloat(matchingRecord.tvd) : measured_depth,
                deepest_formation: matchingRecord.deep_fm || null,
                deviation: matchingRecord.Slant ? deviationMap[matchingRecord.Slant] : null,
                county: matchingRecord.CNTY_NAME || null,
            };

            // Add land use type if coordinates are available
            if (mgsData.latitude && mgsData.longitude) {
                try {
                    mgsData.land_use_type = await landUseService.getLandUseType(mgsData.latitude, mgsData.longitude);
                } catch (error) {
                    console.log(`⚠️ Could not determine land use type for ${mgsData.latitude}, ${mgsData.longitude}: ${error.message}`);
                    mgsData.land_use_type = null;
                }
            } else {
                mgsData.land_use_type = null;
            }

            return mgsData;
        } catch (error) {
            console.error('❌ Error extracting MGS data:', error);
            throw error;
        }
    }

    /**
     * Merge MGS data into existing result JSON
     */
    mergeMGSData(existingResult, mgsData) {
        if (!existingResult || !mgsData) {
            return existingResult;
        }

        const margedData = {
            ...existingResult,
            api_number: mgsData.api_number,
            latitude: mgsData.latitude,
            longitude: mgsData.longitude,
            land_use_type: mgsData.land_use_type,
            lease_name: existingResult.lease_name || mgsData.lease_name,
            well_number: existingResult.well_number || mgsData.well_number,
            elevation: existingResult.elevation || mgsData.elevation,
            elevation_datum: existingResult.elevation_datum || mgsData.elevation_datum,
            well_type: existingResult.well_type || mgsData.well_type,
            status: existingResult.status || mgsData.status,
            measured_depth: existingResult.measured_depth || mgsData.measured_depth,
            true_depth: existingResult.true_depth || mgsData.true_depth,
            deepest_formation: existingResult.deepest_formation || mgsData.deepest_formation,
            deviation: existingResult.deviation || mgsData.deviation,
            county: existingResult.county || mgsData.county,

        }
        return margedData;
    }


    /**
 * Extract permit number from file result data
 */
    extractPermitFromData(result) {
        if (!result) return null;

        // Try common field names for permit numbers
        const permitFields = [
            'permit_number',
            'permitNumber',
            'permit_no',
            'permitNo',
            'permit',
            'permit_id',
            'permitId',
            'well_permit',
            'wellPermit',
            'drilling_permit',
            'drillingPermit'
        ];

        for (const field of permitFields) {
            if (result[field] && typeof result[field] === 'string') {
                // Clean up the permit number (remove spaces, special chars)
                const cleaned = result[field].replace(/[^\d]/g, '');
                if (cleaned.length > 0) {
                    return cleaned;
                }
            }
        }

        return null;
    }

    normalizePermitNumber(permit) {
        if (!permit) return null;
        return permit.trim().replace(/^0+/, '') || '0';
    }
    /**
     * Check if permit numbers match between filename and extracted data
     */
    getPermitNumberFromData(filename, result) {
        const filenamePermit = this.extractPermitFromFilename(filename);
        const dataPermit = this.extractPermitFromData(result);

        const normalizedFilename = this.normalizePermitNumber(filenamePermit);
        const normalizedData = this.normalizePermitNumber(dataPermit);

        return {
            permitNumber: normalizedFilename || normalizedData || null,
            correct: normalizedFilename === normalizedData
        };
    }


    /**
 * Extract permit number from filename
 * Supports various patterns like:
 * - PERMIT12345.pdf
 * - permit_12345.pdf
 * - 12345_permit.pdf
 * - permit-12345.pdf
 */
    extractPermitFromFilename(filename) {
        if (!filename) return null;

        const patterns = [
            /(\d+)/,                    // Any number
            /permit[_-]?(\d+)/i,        // permit123, permit_123, permit-123
            /(\d+)[_-]?permit/i,        // 123permit, 123_permit, 123-permit
            /permit[_-]?(\d+)[_-]?/i,   // permit_123_, permit-123-
            /[_-](\d+)[_-]?permit/i,    // _123_permit, -123-permit
        ];

        for (const pattern of patterns) {
            const match = filename.match(pattern);
            if (match) {
                return match[1];
            }
        }

        return null;
    }
}

const datumMap = {
    'K': 'Kelly Bushing',
    'G': 'Ground',
    'R': 'Rotary Table',
    'D': 'Drill Floor',
}
const deviationMap = {
    'H': 'Horizontal',
    'D': 'Deviated',
    'V': 'Straight',
}
const wellTypeMap = {
    'GAS': "Gas Production",
    'DH': "Dry Hole",
    'MTW': "Mineral",
    'MNB': "Mineral",
    'BDW': "Brine Disposal",
    'OIL': "Oil Production",
    'LOC': "Location",
    'LPG': "LPG",
    'MSM': "Min",
    'WIW': "Water Injection",
    'GSO': "Gas Storage",
    'MDW': "Mineral",
    'GS': "Gas Storage",
    'GIW': "Gas Injection",
    'LHL': "Lost Hole",
    'OTH': "Other",
    'OBS': "Observation",
}

export default new MGSDataService();
