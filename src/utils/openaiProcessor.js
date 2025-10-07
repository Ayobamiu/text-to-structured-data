import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

/**
 * Process text with OpenAI using structured output
 * @param {string} text - The text content to process
 * @param {Object} schemaData - Schema configuration object
 * @param {string} schemaData.schemaName - Name of the schema (optional)
 * @param {Object} schemaData.schema - The JSON schema for structured output
 * @returns {Promise<Object>} - Result object with success, data, and metadata
 */
export async function processWithOpenAI(text, schemaData) {
    try {
        console.log('🤖 Processing with OpenAI...');
        console.log(`📝 Text length: ${text.length} characters`);

        // Ensure schema is properly parsed
        let schema = schemaData.schema;
        if (typeof schema === 'string') {
            try {
                schema = JSON.parse(schema);
            } catch (parseError) {
                throw new Error(`Invalid schema format: ${parseError.message}`);
            }
        }
        console.log('🔍 Schema:', schema);
        const response = await openai.chat.completions.create({
            model: "gpt-4o-2024-08-06",
            messages: [
                {
                    role: "system",
                    content: "You are an expert at structured data extraction from documents. Extract data accurately according to the provided schema, paying attention to document structure, tables, and contextual relationships.",
                },
                {
                    role: "user",
                    content: `Extract structured data from this document according to the provided schema:\n\n${text}`,
                },
            ],
            response_format: {
                type: "json_schema",
                json_schema: {
                    name: schemaData.schemaName || "data_extraction",
                    schema: schema,
                },
            },
        });

        const extractedData = JSON.parse(response.choices[0].message.content);
        console.log('✅ OpenAI processing completed');

        return {
            success: true,
            data: extractedData, // Store only the pure extracted data
            metadata: {
                text_length: text.length,
                processing_time: new Date().toISOString(),
                model: 'gpt-4o-2024-08-06',
                tokens_used: response.usage?.total_tokens || 0
            }
        };

    } catch (error) {
        console.error('❌ OpenAI processing error:', error.message);
        return {
            success: false,
            error: error.message
        };
    }
}

export default { processWithOpenAI };
