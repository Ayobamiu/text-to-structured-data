import { Pipeline } from './Pipeline.js';
import { FormationPageDetectionStage } from './stages/FormationPageDetectionStage.js';
import { MGSPermitFixStage } from './stages/MGSPermitFixStage.js';

/**
 * Standard File Processing Pipeline
 * 
 * This pipeline orchestrates all post-processing stages for a file:
 * 1. MGS Permit Fix (if MGS job)
 * 2. Formation Page Detection (if MGS job)
 * 
 * Usage:
 *   const pipeline = new FileProcessingPipeline();
 *   const context = await pipeline.execute({
 *     fileId: '...',
 *     jobId: '...',
 *     filename: '...',
 *     result: {...},
 *     status: 'completed',
 *     fileInfo: {...},
 *     pages: [...]
 *   });
 */
export class FileProcessingPipeline extends Pipeline {
    constructor(options = {}) {
        super('file_processing', options);

        // Add stages in execution order
        this.addStage(new MGSPermitFixStage(options.mgsPermitFix || {}));
        this.addStage(new FormationPageDetectionStage(options.formationPageDetection || {}));
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

