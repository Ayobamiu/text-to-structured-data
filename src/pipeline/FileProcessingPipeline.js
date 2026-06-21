import { Pipeline } from './Pipeline.js';
import { FormationPageDetectionStage } from './stages/FormationPageDetectionStage.js';
import { MGSPermitFixStage } from './stages/MGSPermitFixStage.js';
import { PostProcessingServicesStage } from './stages/PostProcessingServicesStage.ts';

/**
 * Standard File Processing Pipeline
 *
 * Orchestrates post-processing stages for a file, in order:
 *   1. MGSPermitFixStage — LEGACY/dormant. Self-gates to one hardcoded MGS job
 *      whose "Wrong County Name" flag depends on the mgs_expected_county metadata
 *      this stage emits (see constraintsService.computeFlags). Kept for reference;
 *      go-forward MGS enrichment runs as the `mgs_enrich` service in stage 3.
 *      Remove once the legacy job is migrated off it.
 *   2. FormationPageDetectionStage.
 *   3. PostProcessingServicesStage — config-driven auto-run of registered services
 *      (geocode_locations, mgs_enrich, …), gated per job/slug. Runs last so it sees
 *      any record enrichment from earlier stages.
 *
 * Usage:
 *   const pipeline = new FileProcessingPipeline();
 *   const context = await pipeline.execute({
 *     fileId, jobId, filename, result, status, fileInfo, pages,
 *     postProcessing: { jobOverrides, slugDefaultsBySlug }, // for stage 3
 *   });
 */
export class FileProcessingPipeline extends Pipeline {
    constructor(options = {}) {
        super('file_processing', options);

        // Add stages in execution order
        this.addStage(new MGSPermitFixStage(options.mgsPermitFix || {}));
        this.addStage(new FormationPageDetectionStage(options.formationPageDetection || {}));
        this.addStage(new PostProcessingServicesStage(options.postProcessingServices || {}));
    }

    /**
     * Create a pipeline with custom configuration
     * @param {Object} config - Pipeline configuration
     * @returns {FileProcessingPipeline}
     */
    static create(config = {}) {
        return new FileProcessingPipeline(config);
    }

    /**
     * Execute pipeline with file context
     * @param {Object} fileContext - File processing context
     * @returns {Promise<Object>}
     */
    async processFile(fileContext) {
        return await this.execute(fileContext);
    }
}

