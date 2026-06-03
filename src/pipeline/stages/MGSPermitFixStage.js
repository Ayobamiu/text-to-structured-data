import { PipelineStage } from '../PipelineStage.js';
import mgsDataService from '../../services/mgsDataService.js';
import { addItemsToPreview } from '../../database/previewDataTable.js';
import { isV2Envelope, mapRecords, readField } from '../../utils/resultEnvelope.js';

/**
 * Pipeline stage for MGS-specific processing
 * - Auto-fixes permit numbers
 * - Merges MGS data
 * - Adds to preview
 *
 * Supports both V1 flat results and V2 per-section envelopes.
 * For V2, the fix/merge is applied to every record inside the envelope.
 */
export class MGSPermitFixStage extends PipelineStage {
    constructor(options = {}) {
        super('mgs_permit_fix', {
            enabled: options.enabled !== false,
            required: false,
            retryable: true,
            ...options
        });

        this.jobId = options.jobId || '5667fe82-63e1-47fa-a640-b182b5c5d034';
        this.previewId = options.previewId || '550bff46-db7d-4691-8503-e819273977ee';
    }

    shouldRun(context) {
        if (!super.shouldRun(context)) {
            return false;
        }

        const jobId = context.jobId || context.fileInfo?.job_id;
        return jobId === this.jobId && context.status === 'completed' && context.result;
    }

    async execute(context) {
        const { result, filename } = context;
        const v2 = isV2Envelope(result);

        console.log(`🔧 Starting MGS processing for file ${context.fileId}${v2 ? ' (v2 envelope)' : ''}`);

        // Step 1: Fix permit number (applies to every record)
        let finalResult = mapRecords(result, (record) =>
            mgsDataService.autoFixPermitNumber(record, filename)
        );

        const extractedCountyFromDocument = readField(finalResult, 'county') || null;
        console.log(`✅ Step 1: Permit number fixed for ${filename}`);

        // Step 2: Look up and merge MGS data
        // Read permit from the first record regardless of V1/V2
        const permitNumber = mgsDataService.extractPermitFromData(
            v2 ? _firstRecord(finalResult) : finalResult
        );
        let mgsExpectedCounty = null;
        if (permitNumber) {
            console.log(`🔍 Step 2: Looking up MGS data for permit ${permitNumber}`);
            try {
                const mgsData = await mgsDataService.getMGSDataByPermitNumber(permitNumber);
                if (mgsData) {
                    mgsExpectedCounty = mgsData.county || null;
                    // Merge into every record
                    finalResult = mapRecords(finalResult, (record) =>
                        mgsDataService.mergeMGSData(record, mgsData)
                    );
                    console.log(`✅ Step 2: MGS data populated for permit ${permitNumber}`);

                    // Step 3: Add to preview
                    console.log(`📋 Step 3: Adding file ${context.fileId} to preview`);
                    await addItemsToPreview(this.previewId, [context.fileId]);
                    console.log(`✅ Step 3: File ${context.fileId} added to preview successfully`);
                } else {
                    console.log(`⚠️ Step 2: No MGS data found for permit ${permitNumber}`);
                }
            } catch (error) {
                console.error(`❌ Step 2: Error looking up MGS data: ${error.message}`);
                throw error;
            }
        } else {
            console.log(`⚠️ Step 2: No permit number found, skipping MGS data lookup`);
        }

        const priorMetadata =
            context.metadata && typeof context.metadata === 'object'
                ? context.metadata
                : {};

        return {
            ...context,
            result: finalResult,
            metadata: {
                ...priorMetadata,
                mgs_expected_county: mgsExpectedCounty,
                extracted_county: extractedCountyFromDocument,
            },
            mgsProcessing: {
                success: true,
                permitNumber: permitNumber || null,
                mgsExpectedCounty,
                extractedCounty: extractedCountyFromDocument,
            }
        };
    }
}

/** Grab the first record from a V2 envelope (for permit lookup). */
function _firstRecord(result) {
    for (const arr of Object.values(result)) {
        if (Array.isArray(arr) && arr.length > 0 && arr[0] && typeof arr[0] === 'object') {
            return arr[0];
        }
    }
    return result;
}

