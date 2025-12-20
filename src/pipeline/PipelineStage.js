/**
 * Base class for pipeline stages
 * 
 * Standard Pipeline Pattern:
 * 1. Each stage is independent and testable
 * 2. Stages receive context and return updated context
 * 3. Stages can be skipped conditionally
 * 4. Stages handle their own errors gracefully
 * 5. Stages are idempotent where possible
 */

export class PipelineStage {
    constructor(name, options = {}) {
        this.name = name;
        this.options = options;
        this.enabled = options.enabled !== false; // Enabled by default
        this.retryable = options.retryable !== false; // Retryable by default
        this.required = options.required === true; // Optional by default
    }

    /**
     * Check if this stage should run
     * Override in subclasses for conditional execution
     * @param {Object} context - Pipeline context
     * @returns {boolean}
     */
    shouldRun(context) {
        return this.enabled;
    }

    /**
     * Execute the stage
     * Must be implemented by subclasses
     * @param {Object} context - Pipeline context
     * @returns {Promise<Object>} - Updated context
     */
    async execute(context) {
        throw new Error(`execute() must be implemented by ${this.constructor.name}`);
    }

    /**
     * Validate context before execution
     * Override to add validation
     * @param {Object} context
     * @throws {Error} if context is invalid
     */
    validate(context) {
        // Override in subclasses
    }

    /**
     * Handle errors during execution
     * Override for custom error handling
     * @param {Error} error
     * @param {Object} context
     * @returns {Object} - Updated context with error info
     */
    handleError(error, context) {
        return {
            ...context,
            errors: [
                ...(context.errors || []),
                {
                    stage: this.name,
                    error: error.message,
                    timestamp: new Date().toISOString(),
                    retryable: this.retryable
                }
            ]
        };
    }

    /**
     * Get stage metadata for logging/monitoring
     * @returns {Object}
     */
    getMetadata() {
        return {
            name: this.name,
            enabled: this.enabled,
            retryable: this.retryable,
            required: this.required
        };
    }
}

