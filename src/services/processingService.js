import OpenAI from 'openai';
import QwenProcessor from './qwenProcessor.js';
import {
    PROCESSING_METHODS,
    OPENAI_MODELS_LIST,
    QWEN_MODELS_LIST,
    getDefaultModel as getConfigDefaultModel,
    getDefaultOptions as getConfigDefaultOptions
} from '../config/processingConfig.js';

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

            // Parse schema data if it's a string
            let schema = schemaData;
            if (typeof schemaData === 'string') {
                try {
                    schema = JSON.parse(schemaData);
                } catch (parseError) {
                    throw new Error(`Invalid schema data: ${parseError.message}`);
                }
            }

            // Parse the nested schema string if it exists
            if (schema && schema.schema && typeof schema.schema === 'string') {
                try {
                    schema.schema = JSON.parse(schema.schema);
                } catch (parseError) {
                    throw new Error(`Invalid nested schema: ${parseError.message}`);
                }
            }

            // Validate schema structure
            if (!schema || !schema.schema) {
                throw new Error(`Missing schema in processing data. Got: ${JSON.stringify(schema)}`);
            }

            const systemPrompt = "You are an expert at structured data extraction from documents. Extract data accurately according to the provided schema, paying attention to document structure, tables, and contextual relationships."
            const userPrompt = `Extract structured data from this document according to the provided schema:\n\n${text}`;
            const response = await this.openai.chat.completions.create({
                model: defaultOptions.model,
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userPrompt }
                ],
                response_format: {
                    type: "json_schema",
                    json_schema: {
                        name: schemaData.schemaName || "data_extraction",
                        "strict": true,
                        schema: schema.schema,
                    },
                },
            });

            const extractedData = JSON.parse(response.choices[0].message.content);

            const endTime = Date.now();
            const processingTimeSeconds = (endTime - startTime) / 1000;

            console.log(`✅ OpenAI processing completed with ${defaultOptions.model} in ${processingTimeSeconds.toFixed(2)}s`);

            return {
                success: true,
                data: extractedData,
                method: 'openai',
                ai_processing_time_seconds: processingTimeSeconds,
                metadata: {
                    processing_method: 'openai',
                    model: defaultOptions.model,
                    temperature: defaultOptions.temperature,
                    max_tokens: defaultOptions.max_tokens,
                    tokens_used: response.usage?.total_tokens || 0,
                    processing_time: new Date().toISOString(),
                    processing_time_seconds: processingTimeSeconds,
                    ai_processing_time_seconds: processingTimeSeconds
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
