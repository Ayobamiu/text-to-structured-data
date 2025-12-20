import { PipelineStage } from '../PipelineStage.js';
import { detectAndExtractFormationPages } from '../../services/formationPageDetectionService.js';

/**
 * Pipeline stage for formation page detection and extraction
 * 
 * This stage:
 * - Only runs for specific job IDs (configurable)
 * - Detects pages with formation data using heuristic scoring
 * - Extracts those pages into a new PDF
 * - Stores results in context metadata
 */
export class FormationPageDetectionStage extends PipelineStage {
    constructor(options = {}) {
        super('formation_page_detection', {
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

        // Only run after processing is completed
        if (context.status !== 'completed' || !context.result) {
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
     * Execute formation page detection
     */
    async execute(context) {
        const fileId = context.fileId;
        const fileInfo = context.fileInfo || {
            id: fileId,
            filename: context.filename,
            job_id: context.jobId,
            s3_key: context.s3Key,
            storage_type: context.storageType || 's3'
        };

        // Parse pages if needed
        let pages = context.pages;
        if (!pages && fileInfo.pages) {
            if (typeof fileInfo.pages === 'string') {
                try {
                    pages = JSON.parse(fileInfo.pages);
                } catch (parseError) {
                    throw new Error(`Failed to parse pages JSON: ${parseError.message}`);
                }
            } else if (Array.isArray(fileInfo.pages)) {
                pages = fileInfo.pages;
            }
        }

        if (!pages || !Array.isArray(pages) || pages.length === 0) {
            return {
                ...context,
                formationPageDetection: {
                    success: false,
                    message: 'No pages data available',
                    skipped: true
                }
            };
        }

        console.log(`🔍 Starting formation page detection for file ${fileId}`);

        // Run detection and extraction
        const detectionResult = await detectAndExtractFormationPages(
            fileInfo,
            pages,
            context.localFilePath
        );

        // Update context with results
        return {
            ...context,
            formationPageDetection: {
                success: detectionResult.success,
                extractedPdf: detectionResult.extractedPdf || null,
                scoring: detectionResult.scoringResult || null,
                metadata: detectionResult.metadata || null,
                error: detectionResult.error || null,
                message: detectionResult.message || null
            },
            // Merge into metadata for database storage
            metadata: {
                ...context.metadata,
                formation_page_detection: {
                    success: detectionResult.success,
                    extracted_pdf: detectionResult.extractedPdf || null,
                    scoring: detectionResult.scoringResult || null,
                    metadata: detectionResult.metadata || null,
                    error: detectionResult.error || null,
                    message: detectionResult.message || null
                }
            }
        };
    }

    /**
     * Custom error handling
     */
    handleError(error, context) {
        // Don't fail the pipeline if this stage fails (it's optional)
        console.error(`⚠️ Formation page detection failed (non-fatal): ${error.message}`);

        return {
            ...context,
            formationPageDetection: {
                success: false,
                error: error.message,
                skipped: false
            },
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

