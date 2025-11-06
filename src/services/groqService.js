/**
 * Groq Service for lightweight AI operations
 * Uses OpenAI-compatible SDK since Groq supports OpenAI API format
 */

import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

class GroqService {
    constructor() {
        this.apiKey = process.env.GROQ_API_KEY;
        
        if (!this.apiKey) {
            console.warn('⚠️ GROQ_API_KEY not found in environment variables');
        }

        // Groq uses OpenAI-compatible API at api.groq.com
        this.client = new OpenAI({
            apiKey: this.apiKey,
            baseURL: 'https://api.groq.com/openai/v1'
        });
    }

    /**
     * Generate a job name from a schema
     * @param {Object} schema - JSON schema object
     * @param {string} schemaName - Schema name/identifier
     * @returns {Promise<string>} Generated job name
     */
    async generateJobName(schema, schemaName = 'data_extraction') {
        if (!this.apiKey) {
            console.warn('⚠️ Groq API key not configured, skipping job name generation');
            return null;
        }

        try {
            // Extract schema properties to understand what data is being extracted
            const schemaStr = typeof schema === 'string' ? schema : JSON.stringify(schema, null, 2);
            
            // Build a concise prompt for job name generation
            const prompt = `Generate a short, descriptive job name (2-5 words) for a data extraction job based on this JSON schema.

Schema Name: ${schemaName}

Schema:
${schemaStr}

Requirements:
- Be concise (2-5 words maximum)
- Describe what data is being extracted
- Use title case
- Do not include quotes
- Do not include the word "Job" or "Extraction"
- Be specific and informative

Examples:
- "Well Log Data Extraction" → "Well Log Data"
- "Invoice Processing" → "Invoice Processing"
- "Customer Information Forms" → "Customer Information Forms"

Return only the job name, nothing else.`;

            const completion = await this.client.chat.completions.create({
                model: 'llama-3.1-8b-instant', // Groq's fast, lightweight model
                messages: [
                    {
                        role: 'system',
                        content: 'You are a helpful assistant that generates concise, descriptive names for data extraction jobs. Always return only the job name without any additional text, quotes, or explanations.'
                    },
                    {
                        role: 'user',
                        content: prompt
                    }
                ],
                temperature: 0.3, // Lower temperature for more consistent, focused output
                max_tokens: 20, // Short response for job names
            });

            const generatedName = completion.choices[0]?.message?.content?.trim();
            
            if (!generatedName) {
                console.warn('⚠️ Groq returned empty job name');
                return null;
            }

            // Clean up the response (remove quotes, extra whitespace, etc.)
            let cleanedName = generatedName
                .replace(/^["']|["']$/g, '') // Remove surrounding quotes
                .replace(/^Job\s+/i, '') // Remove "Job" prefix if present
                .replace(/\s+Extraction$/i, '') // Remove "Extraction" suffix if present
                .trim();

            // Fallback if cleaned name is too short or empty
            if (cleanedName.length < 3) {
                console.warn('⚠️ Generated job name too short, using fallback');
                return null;
            }

            // Truncate if too long (max 100 characters)
            if (cleanedName.length > 100) {
                cleanedName = cleanedName.substring(0, 97) + '...';
            }

            console.log(`✅ Generated job name with Groq: "${cleanedName}"`);
            return cleanedName;

        } catch (error) {
            console.error('❌ Error generating job name with Groq:', error.message);
            // Don't throw - gracefully fall back to default naming
            return null;
        }
    }

    /**
     * Check if Groq is available
     * @returns {boolean} True if API key is configured
     */
    isAvailable() {
        return !!this.apiKey;
    }
}

export default new GroqService();

