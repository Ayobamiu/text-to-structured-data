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

            // Extract the required fields
            const mgsData = {
                api_number: matchingRecord.api_wellno || null,
                lease_name: matchingRecord.lease_name || null,
                well_number: matchingRecord.well_no || null,
                latitude: matchingRecord.Latitude ? parseFloat(matchingRecord.Latitude) : null,
                longitude: matchingRecord.Longitude ? parseFloat(matchingRecord.Longitude) : null,
                elevation: matchingRecord.elev_ref ? parseFloat(matchingRecord.elev_ref) : null,
                elevation_datum: matchingRecord.ref_tops ? datumMap[matchingRecord.ref_tops] : null, // Based on CSV structure, seems to be 'K' for most records
                well_type: matchingRecord.well_type || null,
                status: matchingRecord.well_stat || null,
                measured_depth: matchingRecord.dtd ? parseFloat(matchingRecord.dtd) : null,
                true_depth: matchingRecord.tvd ? parseFloat(matchingRecord.tvd) : null,
                deepest_formation: matchingRecord.deep_fm || null,
                deviation: matchingRecord.Slant ? deviationMap[matchingRecord.Slant] : null
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

        // Create a copy of the existing result
        const mergedResult = JSON.parse(JSON.stringify(existingResult));

        // Add MGS data section
        mergedResult.mgs_data = mgsData;

        return mergedResult;
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

export default new MGSDataService();
