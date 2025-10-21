import OpenAI from 'openai';

class ProcessingService {
    constructor() {
        this.openai = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY,
        });
    }

    /**
     * Process extracted text using the specified method
     * @param {string} text - Extracted text/markdown to process
     * @param {Object} schemaData - Schema configuration
     * @param {string} method - Processing method ('openai')
     * @param {Object} options - Method-specific options
     * @returns {Promise<Object>} Processing result
     */
    async processText(text, schemaData, method = 'openai', options = {}) {
        try {
            console.log(`🤖 Processing text using ${method} method`);

            if (method === 'openai') {
                return await this.processWithOpenAI(text, schemaData, options);
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
        try {
            // Merge default options with provided options
            const defaultOptions = {
                model: 'gpt-4o-2024-08-06',
                temperature: 0.1,
                max_tokens: 4000,
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

            console.log(`✅ OpenAI processing completed with ${defaultOptions.model}`);

            return {
                success: true,
                data: extractedData,
                method: 'openai',
                metadata: {
                    processing_method: 'openai',
                    model: defaultOptions.model,
                    temperature: defaultOptions.temperature,
                    max_tokens: defaultOptions.max_tokens,
                    tokens_used: response.usage?.total_tokens || 0,
                    processing_time: new Date().toISOString()
                }
            };

        } catch (error) {
            console.error('❌ OpenAI processing error:', error.message);
            return {
                success: false,
                error: error.message,
                method: 'openai'
            };
        }
    }

    /**
     * Get available processing methods
     * @returns {Array<string>} List of available methods
     */
    getAvailableMethods() {
        return ['openai'];
    }

    /**
     * Get available OpenAI models
     * @returns {Array<string>} List of available models
     */
    getAvailableModels() {
        return ['gpt-4o', 'gpt-4', 'gpt-3.5-turbo'];
    }

    /**
     * Get default options for OpenAI processing
     * @param {string} model - OpenAI model
     * @returns {Object} Default options for the model
     */
    getDefaultOptions(model = 'gpt-4o') {
        const defaultOptions = {
            'gpt-4o': {
                temperature: 0.1,
                max_tokens: 4000
            },
            'gpt-4': {
                temperature: 0.1,
                max_tokens: 4000
            },
            'gpt-3.5-turbo': {
                temperature: 0.2,
                max_tokens: 3000
            }
        };

        return defaultOptions[model] || defaultOptions['gpt-4o'];
    }
}

export default ProcessingService;
