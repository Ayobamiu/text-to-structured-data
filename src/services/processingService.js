import OpenAI from 'openai';
import QwenProcessor from './qwenProcessor.js';
import {
    PROCESSING_METHODS,
    OPENAI_MODELS_LIST,
    QWEN_MODELS_LIST,
    getDefaultModel as getConfigDefaultModel,
    getDefaultOptions as getConfigDefaultOptions,
    getOpenAIUpgradeModel
} from '../config/processingConfig.js';
import { parseOpenAiStructuredResponse, OpenAiTruncationError } from '../utils/openaiResponse.js';
import {
    buildDocumentExtractionMessages,
    buildDocumentExtractionResponseFormat,
    normalizeExtractionSchemaData,
} from '../config/openaiPrompts.ts';

class ProcessingService {
    constructor() {
        this.openai = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY,
        });
        this.qwenProcessor = new QwenProcessor();
    }

    /**
     * Process extracted text using the specified method
     * @param {string} text - Extracted text/markdown to process
     * @param {Object} schemaData - Schema configuration
     * @param {string} method - Processing method ('openai' | 'qwen')
     * @param {Object} options - Method-specific options
     * @returns {Promise<Object>} Processing result
     */
    async processText(text, schemaData, method = 'openai', options = {}) {
        try {
            console.log(`🤖 Processing text using ${method} method`);

            if (method === PROCESSING_METHODS.OPENAI) {
                return await this.processWithOpenAI(text, schemaData, options);
            } else if (method === PROCESSING_METHODS.QWEN) {
                return await this.processWithQwen(text, schemaData, options);
            } else {
                throw new Error(`Unsupported processing method: ${method}`);
            }
        } catch (error) {
            console.error(`❌ Processing error with ${method}:`, error.message);
            return {
                success: false,
                error: error.message,
                method: method
            };
        }
    }

    /**
     * Process text using OpenAI
     * @param {string} text - Text to process
     * @param {Object} schemaData - Schema configuration
     * @param {Object} options - OpenAI options
     * @returns {Promise<Object>} Processing result
     */
    async processWithOpenAI(text, schemaData, options = {}) {
        const startTime = Date.now();

        try {
            // Merge default options with provided options
            const model = options.model || getConfigDefaultModel(PROCESSING_METHODS.OPENAI);
            const modelDefaults = getConfigDefaultOptions(PROCESSING_METHODS.OPENAI, model);
            const defaultOptions = {
                model: model,
                ...modelDefaults,
                ...options
            };

            console.log(`🤖 Processing with OpenAI ${defaultOptions.model}`);

            // Validates + normalises schema (throws if missing/invalid).
            normalizeExtractionSchemaData(schemaData);

            // Single-attempt helper. We retry the same call body with a
            // larger-cap model on truncation; see the catch block below.
            const callOpenAI = async (modelToUse) => {
                const modelOpts = getConfigDefaultOptions(PROCESSING_METHODS.OPENAI, modelToUse) || {};
                // Caller-supplied options win, then the per-model defaults
                // (temperature, max_tokens), then the model name.
                const effective = { ...modelOpts, ...options, model: modelToUse };

                // Forward temperature/max_tokens explicitly. Historically
                // these were computed but never passed to the API call,
                // so the model ran at temperature=1.0 (high output length
                // variance) and the model's hard cap. That caused
                // intermittent finish_reason='length' truncations on
                // dense table pages.
                const apiParams = {
                    model: modelToUse,
                    messages: buildDocumentExtractionMessages(text),
                    response_format: buildDocumentExtractionResponseFormat(schemaData),
                };
                if (typeof effective.temperature === 'number') {
                    apiParams.temperature = effective.temperature;
                }
                if (typeof effective.max_tokens === 'number') {
                    apiParams.max_tokens = effective.max_tokens;
                }

                const response = await this.openai.chat.completions.create(apiParams);
                const data = parseOpenAiStructuredResponse(response, modelToUse);
                return { response, data, effective };
            };

            // First attempt with the requested model.
            let attempt;
            let modelUsed = defaultOptions.model;
            let upgradeInfo = null;
            try {
                attempt = await callOpenAI(modelUsed);
            } catch (firstErr) {
                if (firstErr instanceof OpenAiTruncationError) {
                    // Auto-recover: try once with a model that has a
                    // larger output cap. We only upgrade if there's a
                    // bigger-cap target — gpt-4.1 is currently the
                    // ceiling at 32k. If we're already on it, surface
                    // the truncation error so the operator knows the
                    // schema has outgrown even gpt-4.1 (next move is
                    // schema chunking).
                    const upgradeModel = getOpenAIUpgradeModel(modelUsed);
                    if (!upgradeModel) {
                        throw firstErr;
                    }
                    console.warn(
                        `⚠️ ${modelUsed} truncated (completion=${firstErr.completion_tokens} tokens, ` +
                        `total=${firstErr.total_tokens} tokens). Auto-retrying with ${upgradeModel} (larger output cap).`
                    );
                    upgradeInfo = {
                        retried_due_to: 'truncation',
                        original_model: modelUsed,
                        original_completion_tokens: firstErr.completion_tokens,
                        original_total_tokens: firstErr.total_tokens,
                    };
                    modelUsed = upgradeModel;
                    attempt = await callOpenAI(modelUsed);
                } else {
                    throw firstErr;
                }
            }

            const { response, data: extractedData, effective } = attempt;
            const endTime = Date.now();
            const processingTimeSeconds = (endTime - startTime) / 1000;

            console.log(
                `✅ OpenAI processing completed with ${modelUsed} in ${processingTimeSeconds.toFixed(2)}s` +
                (upgradeInfo ? ` (auto-upgraded from ${upgradeInfo.original_model} after truncation)` : '')
            );

            return {
                success: true,
                data: extractedData,
                method: 'openai',
                ai_processing_time_seconds: processingTimeSeconds,
                metadata: {
                    processing_method: 'openai',
                    model: modelUsed,
                    temperature: effective.temperature,
                    max_tokens: effective.max_tokens,
                    tokens_used: response.usage?.total_tokens || 0,
                    prompt_tokens: response.usage?.prompt_tokens || 0,
                    completion_tokens: response.usage?.completion_tokens || 0,
                    processing_time: new Date().toISOString(),
                    processing_time_seconds: processingTimeSeconds,
                    ai_processing_time_seconds: processingTimeSeconds,
                    ...(upgradeInfo ? { upgrade: upgradeInfo } : {})
                }
            };

        } catch (error) {
            const endTime = Date.now();
            const processingTimeSeconds = (endTime - startTime) / 1000;

            console.error('❌ OpenAI processing error:', error.message);
            return {
                success: false,
                error: error.message,
                method: 'openai',
                ai_processing_time_seconds: processingTimeSeconds,
                metadata: {
                    processing_time_seconds: processingTimeSeconds,
                    ai_processing_time_seconds: processingTimeSeconds
                }
            };
        }
    }

    /**
     * Process text using Qwen
     * @param {string} text - Text to process
     * @param {Object} schemaData - Schema configuration
     * @param {Object} options - Qwen options
     * @returns {Promise<Object>} Processing result
     */
    async processWithQwen(text, schemaData, options = {}) {
        return await this.qwenProcessor.processWithQwen(text, schemaData, options);
    }

    /**
     * Get available processing methods
     * @returns {Array<string>} List of available methods
     */
    getAvailableMethods() {
        return Object.values(PROCESSING_METHODS);
    }

    /**
     * Get available OpenAI models
     * @returns {Array<string>} List of available models
     */
    getAvailableOpenAIModels() {
        return OPENAI_MODELS_LIST;
    }

    /**
     * Get available Qwen models
     * @returns {Array<string>} List of available models
     */
    getAvailableQwenModels() {
        return QWEN_MODELS_LIST;
    }

    /**
     * Get available models for a specific method
     * @param {string} method - Processing method
     * @returns {Array<string>|Object} List of available models or object with all methods
     */
    getAvailableModels(method = null) {
        if (method === PROCESSING_METHODS.OPENAI) {
            return this.getAvailableOpenAIModels();
        } else if (method === PROCESSING_METHODS.QWEN) {
            return this.getAvailableQwenModels();
        }
        // Return all models if no method specified
        return {
            [PROCESSING_METHODS.OPENAI]: this.getAvailableOpenAIModels(),
            [PROCESSING_METHODS.QWEN]: this.getAvailableQwenModels()
        };
    }

    /**
     * Get default options for OpenAI processing
     * @param {string} model - OpenAI model
     * @returns {Object} Default options for the model
     */
    getDefaultOptions(model = getConfigDefaultModel(PROCESSING_METHODS.OPENAI)) {
        return getConfigDefaultOptions(PROCESSING_METHODS.OPENAI, model);
    }

    /**
     * Get default options for Qwen processing
     * @param {string} model - Qwen model
     * @returns {Object} Default options for the model
     */
    getDefaultQwenOptions(model = getConfigDefaultModel(PROCESSING_METHODS.QWEN)) {
        return getConfigDefaultOptions(PROCESSING_METHODS.QWEN, model);
    }
}

export default ProcessingService;
