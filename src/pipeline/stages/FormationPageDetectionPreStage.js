import { PipelineStage } from '../PipelineStage.js';
import { scorePages } from '../../services/formationPageDetectionService.js';

/**
 * Pre-processing stage for formation page detection
 * 
 * This stage runs BEFORE AI processing to identify pages with formation data.
 * It only scores pages and returns confidentHits - no PDF extraction.
 * The confidentHits are used to filter markdown content for AI processing.
 */
export class FormationPageDetectionPreStage extends PipelineStage {
    constructor(options = {}) {
        super('formation_page_detection_pre', {
            enabled: options.enabled !== false,
            required: false, // Optional stage
            retryable: true,
            ...options
        });

        // Configuration
        this.jobIds = options.jobIds || ['5667fe82-63e1-47fa-a640-b182b5c5d034']; // MGS job by default
        this.requirePages = options.requirePages !== false; // Require pages data
    }

    /**
     * Check if stage should run
     * Only runs for configured job IDs and when pages are available
     * Runs in pre-processing context (after extraction, before AI processing)
     */
    shouldRun(context) {
        if (!super.shouldRun(context)) {
            return false;
        }

        // Check job ID
        const jobId = context.jobId || context.fileInfo?.job_id;
        if (!jobId || !this.jobIds.includes(jobId)) {
            return false;
        }

        // Check if pages are available
        if (this.requirePages) {
            const pages = context.pages || context.fileInfo?.pages;
            if (!pages || !Array.isArray(pages) || pages.length === 0) {
                return false;
            }
        }

        // Run in pre-processing context (extraction completed, no result yet)
        // We check for extraction_status or just presence of pages
        if (context.extractionStatus && context.extractionStatus !== 'completed') {
            return false;
        }

        return true;
    }

    /**
     * Validate context
     */
    validate(context) {
        super.validate(context);

        if (!context.fileId) {
            throw new Error('fileId is required in context');
        }

        const pages = context.pages || context.fileInfo?.pages;
        if (this.requirePages && (!pages || !Array.isArray(pages))) {
            throw new Error('pages array is required in context');
        }
    }

    /**
     * Execute formation page detection (pre-processing)
     * Only scores pages and returns confidentHits - no PDF extraction
     */
    async execute(context) {
        const fileId = context.fileId;

        // Parse pages if needed
        let pages = context.pages;
        if (!pages && context.fileInfo?.pages) {
            if (typeof context.fileInfo.pages === 'string') {
                try {
                    pages = JSON.parse(context.fileInfo.pages);
                } catch (parseError) {
                    throw new Error(`Failed to parse pages JSON: ${parseError.message}`);
                }
            } else if (Array.isArray(context.fileInfo.pages)) {
                pages = context.fileInfo.pages;
            }
        }

        if (!pages || !Array.isArray(pages) || pages.length === 0) {
            return {
                ...context,
                formationPageDetectionPre: {
                    success: false,
                    message: 'No pages data available',
                    skipped: true,
                    confidentHits: []
                }
            };
        }

        console.log(`🔍 [Pre-processing] Starting formation page detection for file ${fileId}`);

        // Score pages and get confidentHits
        const scoringResult = scorePages(pages);

        const confidentHits = scoringResult.confidentHits || [];

        console.log(`✅ [Pre-processing] Formation page detection completed: ${confidentHits.length} confident hits out of ${pages.length} pages`);

        // Update context with results
        return {
            ...context,
            formationPageDetectionPre: {
                success: true,
                confidentHits: confidentHits,
                scoring: scoringResult,
                summary: scoringResult.summary
            },
            // Store confidentHits in metadata for later use in AI processing
            metadata: {
                ...context.metadata,
                formation_page_detection_pre: {
                    success: true,
                    confidentHits: confidentHits,
                    scoring: scoringResult,
                    summary: scoringResult.summary
                }
            },
            // Also store directly in context for easy access
            confidentHits: confidentHits
        };
    }

    /**
     * Custom error handling
     */
    handleError(error, context) {
        // Don't fail the pipeline if this stage fails (it's optional)
        console.error(`⚠️ Formation page detection (pre-processing) failed (non-fatal): ${error.message}`);

        return {
            ...context,
            formationPageDetectionPre: {
                success: false,
                error: error.message,
                skipped: false,
                confidentHits: []
            },
            confidentHits: [], // Empty array as fallback
            errors: [
                ...(context.errors || []),
                {
                    stage: this.name,
                    error: error.message,
                    timestamp: new Date().toISOString(),
                    retryable: this.retryable,
                    fatal: false // Non-fatal error
                }
            ]
        };
    }
}

