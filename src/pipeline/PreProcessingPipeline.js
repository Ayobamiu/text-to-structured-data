import { Pipeline } from './Pipeline.js';
import { FormationPageDetectionPreStage } from './stages/FormationPageDetectionPreStage.js';

/**
 * Pre-Processing Pipeline
 * 
 * This pipeline runs AFTER text extraction but BEFORE AI processing.
 * It identifies and filters content to improve AI processing quality.
 * 
 * Stages:
 * 1. Formation Page Detection (pre-processing) - Identifies pages with formation data
 * 
 * Usage:
 *   const pipeline = new PreProcessingPipeline();
 *   const context = await pipeline.execute({
 *     fileId: '...',
 *     jobId: '...',
 *     filename: '...',
 *     extractionStatus: 'completed',
 *     fileInfo: {...},
 *     pages: [...]
 *   });
 */
export class PreProcessingPipeline extends Pipeline {
    constructor(options = {}) {
        super('pre_processing', options);

        // Add stages in execution order
        this.addStage(new FormationPageDetectionPreStage(options.formationPageDetection || {}));
    }

    /**
     * Create a pipeline with custom configuration
     * @param {Object} config - Pipeline configuration
     * @returns {PreProcessingPipeline}
     */
    static create(config = {}) {
        return new PreProcessingPipeline(config);
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

