import { PipelineStage } from './PipelineStage.js';

/**
 * Pipeline orchestrator
 * 
 * Standard Pipeline Features:
 * - Sequential execution with dependency management
 * - Error handling and recovery
 * - Stage skipping based on conditions
 * - Observability (logging, metrics)
 * - Context passing between stages
 * - Retry capability
 */
export class Pipeline {
    constructor(name, options = {}) {
        this.name = name;
        this.stages = [];
        this.options = {
            stopOnError: options.stopOnError !== false, // Stop on required stage errors
            logProgress: options.logProgress !== false, // Log stage progress
            ...options
        };
        this.context = null;
    }

    /**
     * Add a stage to the pipeline
     * @param {PipelineStage} stage
     * @returns {Pipeline} - For method chaining
     */
    addStage(stage) {
        if (!(stage instanceof PipelineStage)) {
            throw new Error('Stage must be an instance of PipelineStage');
        }
        this.stages.push(stage);
        return this;
    }

    /**
     * Add multiple stages
     * @param {Array<PipelineStage>} stages
     * @returns {Pipeline}
     */
    addStages(stages) {
        stages.forEach(stage => this.addStage(stage));
        return this;
    }

    /**
     * Execute the pipeline
     * @param {Object} initialContext - Initial pipeline context
     * @returns {Promise<Object>} - Final context with results
     */
    async execute(initialContext = {}) {
        this.context = {
            pipeline: this.name,
            startTime: Date.now(),
            stages: [],
            errors: [],
            metadata: {},
            ...initialContext
        };

        if (this.options.logProgress) {
            console.log(`🚀 Starting pipeline: ${this.name}`);
            console.log(`📋 Stages: ${this.stages.length}`);
        }

        for (let i = 0; i < this.stages.length; i++) {
            const stage = this.stages[i];
            const stageStartTime = Date.now();

            try {
                // Check if stage should run
                if (!stage.shouldRun(this.context)) {
                    if (this.options.logProgress) {
                        console.log(`⏭️  Skipping stage: ${stage.name}`);
                    }
                    this.context.stages.push({
                        name: stage.name,
                        status: 'skipped',
                        duration: 0
                    });
                    continue;
                }

                // Validate context
                stage.validate(this.context);

                // Execute stage
                if (this.options.logProgress) {
                    console.log(`▶️  Executing stage: ${stage.name} (${i + 1}/${this.stages.length})`);
                }

                const updatedContext = await stage.execute(this.context);
                const duration = Date.now() - stageStartTime;

                // Update context
                this.context = {
                    ...this.context,
                    ...updatedContext
                };

                // Record stage completion
                this.context.stages.push({
                    name: stage.name,
                    status: 'completed',
                    duration,
                    metadata: stage.getMetadata()
                });

                if (this.options.logProgress) {
                    console.log(`✅ Stage completed: ${stage.name} (${duration}ms)`);
                }

            } catch (error) {
                const duration = Date.now() - stageStartTime;

                // Handle error
                this.context = stage.handleError(error, this.context);

                // Record stage failure
                this.context.stages.push({
                    name: stage.name,
                    status: 'failed',
                    duration,
                    error: error.message,
                    metadata: stage.getMetadata()
                });

                console.error(`❌ Stage failed: ${stage.name} - ${error.message}`);

                // Stop pipeline if required stage fails and stopOnError is true
                if (stage.required && this.options.stopOnError) {
                    console.error(`🛑 Stopping pipeline due to required stage failure: ${stage.name}`);
                    break;
                }

                // Continue to next stage if not required or stopOnError is false
            }
        }

        // Finalize context
        this.context.endTime = Date.now();
        this.context.totalDuration = this.context.endTime - this.context.startTime;
        this.context.success = this.context.errors.length === 0;

        if (this.options.logProgress) {
            console.log(`🏁 Pipeline completed: ${this.name} (${this.context.totalDuration}ms)`);
            console.log(`   Stages: ${this.context.stages.length}, Errors: ${this.context.errors.length}`);
        }

        return this.context;
    }

    /**
     * Get pipeline summary
     * @returns {Object}
     */
    getSummary() {
        if (!this.context) {
            return { status: 'not_executed' };
        }

        return {
            name: this.name,
            success: this.context.success,
            duration: this.context.totalDuration,
            stages: this.context.stages.length,
            completed: this.context.stages.filter(s => s.status === 'completed').length,
            failed: this.context.stages.filter(s => s.status === 'failed').length,
            skipped: this.context.stages.filter(s => s.status === 'skipped').length,
            errors: this.context.errors.length
        };
    }
}

