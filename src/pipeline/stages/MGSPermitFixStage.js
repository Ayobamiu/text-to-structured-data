import { PipelineStage } from '../PipelineStage.js';
import mgsDataService from '../../services/mgsDataService.js';
import { addItemsToPreview } from '../../database/previewDataTable.js';

/**
 * Pipeline stage for MGS-specific processing
 * - Auto-fixes permit numbers
 * - Merges MGS data
 * - Adds to preview
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

        console.log(`🔧 Starting MGS processing for file ${context.fileId}`);

        // Step 1: Fix permit number
        let finalResult = mgsDataService.autoFixPermitNumber(result, filename);
        console.log(`✅ Step 1: Permit number fixed for ${filename}`);

        // Step 2: Look up and merge MGS data
        const permitNumber = mgsDataService.extractPermitFromData(finalResult);
        if (permitNumber) {
            console.log(`🔍 Step 2: Looking up MGS data for permit ${permitNumber}`);
            try {
                const mgsData = await mgsDataService.getMGSDataByPermitNumber(permitNumber);
                if (mgsData) {
                    finalResult = mgsDataService.mergeMGSData(finalResult, mgsData);
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

        return {
            ...context,
            result: finalResult,
            mgsProcessing: {
                success: true,
                permitNumber: permitNumber || null
            }
        };
    }
}

