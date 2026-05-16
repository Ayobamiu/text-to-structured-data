import OpenAI from 'openai';
import dotenv from 'dotenv';
import { parseOpenAiStructuredResponse, OpenAiTruncationError } from './openaiResponse.js';
import {
    PROCESSING_METHODS,
    getDefaultModel as getConfigDefaultModel,
    getDefaultOptions as getConfigDefaultOptions,
    getOpenAIUpgradeModel,
} from '../config/processingConfig.js';

dotenv.config();

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

/**
 * Process text with OpenAI using structured output.
 *
 * NOTE: this used to call `openai.chat.completions.create` without
 * forwarding `temperature` or `max_tokens`, so the model ran at
 * default temperature (1.0, high output-length variance) and the
 * model's hard output cap. On dense table pages that combination
 * produced intermittent `finish_reason='length'` truncations, which
 * blew up `JSON.parse` with `Unexpected end of JSON input`. We now
 * explicitly forward both options and use a defensive parser that
 * surfaces the actual failure mode (truncation, refusal, empty,
 * parse error) instead of an opaque message.
 *
 * @param {string} text - The text content to process
 * @param {Object} schemaData - Schema configuration object
 * @param {string} [schemaData.schemaName] - Name of the schema
 * @param {Object} schemaData.schema - The JSON schema for structured output
 * @param {Object} [options] - Optional overrides
 * @param {string} [options.model] - OpenAI model. Defaults to config default.
 * @param {number} [options.temperature] - Sampling temperature.
 * @param {number} [options.max_tokens] - Output token cap.
 * @returns {Promise<Object>} - Result object with success, data, and metadata
 */
export async function processWithOpenAI(text, schemaData, options = {}) {
    const startTime = Date.now();

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

        const initialModel = options.model || getConfigDefaultModel(PROCESSING_METHODS.OPENAI);

        const callOpenAI = async (modelToUse) => {
            const modelOpts = getConfigDefaultOptions(PROCESSING_METHODS.OPENAI, modelToUse) || {};
            const effective = { ...modelOpts, ...options, model: modelToUse };

            const apiParams = {
                model: modelToUse,
                messages: [
                    {
                        // Keep this prompt in sync with services/processingService.js —
                        // both paths share the same OpenAI structured-output
                        // completeness failure mode (model stops early on
                        // long tables despite ample max_tokens headroom).
                        role: 'system',
                        content:
                            'You are an expert at structured data extraction from documents. ' +
                            'Extract data ACCURATELY and EXHAUSTIVELY according to the provided JSON schema. ' +
                            'When the source contains repeating structures (tables, lists, rows, line items), ' +
                            'you MUST emit one schema item per source row — do not summarise, sample, truncate, ' +
                            'or stop early. Iterate through every row top-to-bottom before closing the array. ' +
                            'Never invent rows that are not present in the source; if a cell is missing, omit it ' +
                            "or use the schema's null-equivalent. Counts in metadata (e.g. total_rows, " +
                            'total_items) must match the actual number of items you emitted.',
                    },
                    {
                        role: 'user',
                        content:
                            'Extract structured data from this document according to the provided schema. ' +
                            'Repeat the same emission pattern for EVERY row/item that appears in the source — ' +
                            'do not stop after the first few. ' +
                            'When in doubt about how many rows the source contains, count <tr>, list items, ' +
                            `or line breaks before answering.\n\nDOCUMENT:\n\n${text}`,
                    },
                ],
                response_format: {
                    type: 'json_schema',
                    json_schema: {
                        name: schemaData.schemaName || 'data_extraction',
                        strict: true,
                        schema,
                    },
                },
            };
            if (typeof effective.temperature === 'number') {
                apiParams.temperature = effective.temperature;
            }
            if (typeof effective.max_tokens === 'number') {
                apiParams.max_tokens = effective.max_tokens;
            }

            const response = await openai.chat.completions.create(apiParams);
            const data = parseOpenAiStructuredResponse(response, modelToUse);
            return { response, data };
        };

        // First attempt + auto-upgrade on truncation. See processingService
        // for the same pattern; comments there explain the recovery model.
        let modelUsed = initialModel;
        let upgradeInfo = null;
        let attempt;
        try {
            attempt = await callOpenAI(modelUsed);
        } catch (firstErr) {
            if (firstErr instanceof OpenAiTruncationError) {
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

        const { response, data: extractedData } = attempt;
        console.log(
            `✅ OpenAI processing completed${upgradeInfo ? ` (auto-upgraded from ${upgradeInfo.original_model} to ${modelUsed} after truncation)` : ''}`
        );

        const endTime = Date.now();
        const processingTimeSeconds = (endTime - startTime) / 1000;

        return {
            success: true,
            data: extractedData,
            metadata: {
                text_length: text.length,
                processing_time: new Date().toISOString(),
                model: modelUsed,
                tokens_used: response.usage?.total_tokens || 0,
                prompt_tokens: response.usage?.prompt_tokens || 0,
                completion_tokens: response.usage?.completion_tokens || 0,
                processing_time_seconds: processingTimeSeconds,
                ...(upgradeInfo ? { upgrade: upgradeInfo } : {})
            },
        };
    } catch (error) {
        const endTime = Date.now();
        const processingTimeSeconds = (endTime - startTime) / 1000;
        console.error('❌ OpenAI processing error:', error.message);
        return {
            success: false,
            error: error.message,
            metadata: {
                processing_time_seconds: processingTimeSeconds,
            },
        };
    }
}

export default { processWithOpenAI };
