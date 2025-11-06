/**
 * Qwen Processor for Alibaba Cloud DashScope API
 * Uses OpenAI-compatible SDK for structured data extraction
 */

import OpenAI from 'openai';
import dotenv from 'dotenv';
import {
    QWEN_MODELS_LIST,
    QWEN_DEFAULT_OPTIONS,
    DEFAULT_MODELS,
    PROCESSING_METHODS,
    getDefaultOptions as getConfigDefaultOptions
} from '../config/processingConfig.js';

dotenv.config();

class QwenProcessor {
    constructor() {
        this.apiKey = process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY;
        // Default to Singapore region, can be overridden for China (Beijing) region
        this.baseURL = process.env.DASHSCOPE_BASE_URL || process.env.QWEN_API_URL || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';

        if (!this.apiKey) {
            console.warn('⚠️ DASHSCOPE_API_KEY or QWEN_API_KEY not found in environment variables');
        }

        // Initialize OpenAI client with DashScope configuration
        this.client = new OpenAI({
            apiKey: this.apiKey,
            baseURL: this.baseURL
        });
    }

    /**
     * Process text with Qwen using prompt-based JSON extraction
     * @param {string} text - Text content to process
     * @param {Object} schemaData - Schema configuration
     * @param {string} schemaData.schemaName - Name of the schema
     * @param {Object} schemaData.schema - JSON schema object
     * @param {Object} options - Processing options
     * @returns {Promise<Object>} Processing result
     */
    async processWithQwen(text, schemaData, options = {}) {
        const startTime = Date.now();

        try {
            // Merge default options - use default model from config
            const model = options.model || DEFAULT_MODELS[PROCESSING_METHODS.QWEN];
            const defaultOptionsForModel = getConfigDefaultOptions(PROCESSING_METHODS.QWEN, model);
            const defaultOptions = {
                model: model,
                ...defaultOptionsForModel,
                ...options
            };

            console.log(`🤖 Processing with Qwen ${defaultOptions.model}`);

            if (!this.apiKey) {
                throw new Error('DASHSCOPE_API_KEY or QWEN_API_KEY is not configured');
            }

            // Parse schema
            let schema = schemaData;
            if (typeof schemaData === 'string') {
                try {
                    schema = JSON.parse(schemaData);
                } catch (parseError) {
                    throw new Error(`Invalid schema data: ${parseError.message}`);
                }
            }

            // Parse nested schema if it exists
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

            // Build optimized prompt with schema description and examples
            const systemPrompt = this.buildSystemPrompt(schema.schema, schemaData.schemaName);
            const userPrompt = this.buildUserPrompt(text, schema.schema);

            // Use OpenAI-compatible SDK (DashScope supports OpenAI-compatible API)
            const completion = await this.client.chat.completions.create({
                model: defaultOptions.model,
                messages: [
                    {
                        role: 'system',
                        content: systemPrompt
                    },
                    {
                        role: 'user',
                        content: userPrompt
                    }
                ],
                temperature: defaultOptions.temperature,
                top_p: defaultOptions.top_p,
                max_tokens: defaultOptions.max_tokens,
                response_format: {
                    type: "json_object" // Qwen supports json_object response format
                }
            });

            // Extract response content
            const extractedContent = completion.choices[0].message.content;
            const finishReason = completion.choices[0].finish_reason;

            if (!extractedContent) {
                throw new Error('No content in Qwen API response');
            }

            // Check if response was truncated due to max_tokens limit
            const wasTruncated = finishReason === 'length' || finishReason === 'stop';
            if (wasTruncated && finishReason === 'length') {
                console.warn(`⚠️ Qwen response was truncated (finish_reason: ${finishReason}). Consider increasing max_tokens.`);
            }

            // Parse JSON from response
            let extractedData;
            try {
                extractedData = JSON.parse(extractedContent);
            } catch (parseError) {
                // Check if the error is due to truncated response (incomplete JSON)
                const isTruncated = finishReason === 'length' ||
                                   extractedContent.trim().endsWith('"') || 
                                   extractedContent.trim().endsWith(',') ||
                                   extractedContent.trim().endsWith('[') ||
                                   extractedContent.trim().endsWith('{') ||
                                   (parseError.message.includes('position') && 
                                    !extractedContent.trim().endsWith('}'));
                
                if (isTruncated) {
                    const errorMsg = `Qwen response was truncated (likely exceeded max_tokens limit of ${defaultOptions.max_tokens}). The JSON response was cut off mid-output. ` +
                                   `Used ${completion.usage?.total_tokens || 'unknown'} tokens. ` +
                                   `Consider increasing max_tokens in processing options or simplifying the schema. ` +
                                   `Parse error: ${parseError.message}. Response preview: ${extractedContent.substring(0, 500)}...`;
                    throw new Error(errorMsg);
                }
                
                throw new Error(`Failed to parse JSON from Qwen response: ${parseError.message}. Response preview: ${extractedContent.substring(0, 500)}...`);
            }

            const endTime = Date.now();
            const processingTimeSeconds = (endTime - startTime) / 1000;

            console.log(`✅ Qwen processing completed with ${defaultOptions.model} in ${processingTimeSeconds.toFixed(2)}s`);

            return {
                success: true,
                data: extractedData,
                method: 'qwen',
                ai_processing_time_seconds: processingTimeSeconds,
                metadata: {
                    processing_method: 'qwen',
                    model: defaultOptions.model,
                    temperature: defaultOptions.temperature,
                    top_p: defaultOptions.top_p,
                    max_tokens: defaultOptions.max_tokens,
                    tokens_used: completion.usage?.total_tokens || 0,
                    processing_time: new Date().toISOString(),
                    processing_time_seconds: processingTimeSeconds,
                    ai_processing_time_seconds: processingTimeSeconds
                }
            };

        } catch (error) {
            const endTime = Date.now();
            const processingTimeSeconds = (endTime - startTime) / 1000;

            console.error('❌ Qwen processing error:', error.message);

            // Extract error message from OpenAI SDK error
            let errorMessage = error.message;
            if (error.response) {
                errorMessage = error.response.data?.message || error.response.data?.error?.message || errorMessage;
            }

            return {
                success: false,
                error: errorMessage,
                method: 'qwen',
                ai_processing_time_seconds: processingTimeSeconds,
                metadata: {
                    processing_time_seconds: processingTimeSeconds,
                    ai_processing_time_seconds: processingTimeSeconds
                }
            };
        }
    }

    /**
     * Build optimized system prompt for Qwen with schema description
     * Based on DashScope best practices: include detailed schema descriptions and examples
     * @param {Object} schema - JSON schema object
     * @param {string} schemaName - Schema name
     * @returns {string} System prompt
     */
    buildSystemPrompt(schema, schemaName = 'data_extraction') {
        const schemaDescription = this.describeSchema(schema);

        return `You are an expert at structured data extraction from documents. Extract data accurately according to the provided JSON schema, paying attention to document structure, tables, and contextual relationships.

[Output Format Requirements]
The output must strictly follow the JSON schema provided. All required fields must be present. Optional fields should only be included if data is found in the document.

[Schema Structure]
${schemaDescription}

[Field Extraction Rules]
- Extract data exactly as it appears in the document when possible
- Follow the data types specified in the schema (string, number, array, object, etc.)
- For required fields, ensure they are always present in the output
- For optional fields, only include them if the data exists in the document
- Pay attention to nested objects and arrays as specified in the schema

[Schema Name: ${schemaName}]

Strictly follow the schema format and rules above to extract information and output a valid JSON object. Return ONLY the JSON object, no markdown formatting or explanations.`;
    }

    /**
     * Build user prompt with text and schema
     * @param {string} text - Document text to extract from
     * @param {Object} schema - JSON schema object
     * @returns {string} User prompt
     */
    buildUserPrompt(text, schema) {
        return `Extract structured data from the following document according to the JSON schema provided in the system prompt.

Document Content:
\`\`\`
${text}
\`\`\`

Return the extracted data as a valid JSON object that strictly conforms to the schema. Return ONLY the JSON object, no markdown code blocks or explanations.`;
    }

    /**
     * Generate a human-readable description of the schema
     * @param {Object} schema - JSON schema object
     * @param {number} depth - Current depth level
     * @returns {string} Schema description
     */
    describeSchema(schema, depth = 0) {
        if (!schema || typeof schema !== 'object') {
            return '';
        }

        let description = '';
        const indent = '  '.repeat(depth);

        if (schema.type === 'object' && schema.properties) {
            description += `${indent}Object with properties:\n`;
            for (const [key, value] of Object.entries(schema.properties)) {
                const required = schema.required?.includes(key) ? ' (required)' : ' (optional)';
                const desc = value.description ? ` - ${value.description}` : '';
                description += `${indent}  - ${key}${required}${desc}\n`;

                if (value.type === 'object' || value.type === 'array') {
                    description += this.describeSchema(value, depth + 2);
                }
            }
        } else if (schema.type === 'array' && schema.items) {
            description += `${indent}Array of:\n`;
            description += this.describeSchema(schema.items, depth + 1);
        } else {
            const type = schema.type || 'unknown';
            const desc = schema.description ? ` - ${schema.description}` : '';
            description += `${indent}${type}${desc}\n`;
        }

        return description;
    }

    /**
     * Get available Qwen models
     * @returns {Array<string>} List of available models
     */
    getAvailableModels() {
        return QWEN_MODELS_LIST;
    }

    /**
     * Get default options for Qwen processing
     * @param {string} model - Qwen model name
     * @returns {Object} Default options for the model
     */
    getDefaultOptions(model = DEFAULT_MODELS[PROCESSING_METHODS.QWEN]) {
        return getConfigDefaultOptions(PROCESSING_METHODS.QWEN, model);
    }
}

export default QwenProcessor;

