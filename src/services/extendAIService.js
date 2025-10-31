import { ExtendClient } from 'extend-ai';
import dotenv from 'dotenv';

dotenv.config();

/**
 * ExtendAI Service
 * Handles text extraction using ExtendAI API
 * Requires files to be accessible via URL (S3 signed URLs)
 */
class ExtendAIService {
    constructor() {
        this.apiKey = process.env.EXTEND_API_KEY;
        this.apiVersion = process.env.EXTEND_API_VERSION || '2025-04-21';
        this.apiBase = process.env.EXTEND_API_BASE || 'https://api.extend.ai';

        if (!this.apiKey) {
            console.warn('⚠️ EXTEND_API_KEY not found in environment variables');
        }

        // Initialize ExtendClient
        if (this.apiKey) {
            this.client = new ExtendClient({
                environment: this.apiBase,
                token: this.apiKey,
            });
        }
    }

    /**
     * Check if ExtendAI is properly configured
     * @returns {boolean}
     */
    isConfigured() {
        return !!this.apiKey;
    }

    /**
     * Parse file using ExtendAI API via URL
     * @param {string} fileUrl - Publicly accessible URL to the PDF file
     * @param {string} filename - Original filename
     * @returns {Promise<Object>} Extraction result in standardized format
     */
    async parseFromUrl(fileUrl, filename) {
        try {
            if (!this.isConfigured() || !this.client) {
                throw new Error('ExtendAI API key not configured');
            }

            console.log(`🔗 Calling ExtendAI API for: ${filename}`);
            console.log(`📎 File URL: ${fileUrl}`);

            // Use ExtendClient to parse file
            const response = await this.client.parse({
                extendApiVersion: this.apiVersion,
                file: {
                    fileName: filename,
                    fileUrl: fileUrl
                }
            });

            // Log response for debugging
            console.log(`📥 ExtendAI API response received for ${filename}`);

            if (!response) {
                throw new Error('ExtendAI API returned empty response');
            }

            // Check for error in response
            if (response.success === false || response.error) {
                const errorMsg = response.error || response.message || 'Unknown error from ExtendAI';
                throw new Error(`ExtendAI API error: ${errorMsg}`);
            }

            // Convert ExtendAI response to standardized format
            const extractedData = this.convertExtendAIResponse(response, filename);

            console.log(`✅ ExtendAI extraction completed: ${extractedData.pages.length} pages, ${extractedData.tables.length} tables`);
            return extractedData;

        } catch (error) {
            console.error(`❌ ExtendAI extraction error:`, error.message);
            if (error.response) {
                console.error(`❌ ExtendAI API response:`, error.response.data || error.response);
                const errorMsg = error.response.data?.message || error.response.data?.error || error.message || error.response.message;
                throw new Error(`ExtendAI API error: ${errorMsg}`);
            }
            // Handle ExtendAI SDK errors
            if (error.message) {
                throw new Error(`ExtendAI API error: ${error.message}`);
            }
            throw error;
        }
    }

    /**
     * Convert ExtendAI API response to standardized format
     * @param {Object} extendAIResponse - Response from ExtendAI API
     * @param {string} filename - Original filename
     * @returns {Object} Standardized extraction result
     */
    convertExtendAIResponse(extendAIResponse, filename) {
        try {
            // Log raw response structure for debugging
            console.log(`🔄 Converting ExtendAI response for ${filename}`);

            // ExtendAI response structure based on actual API response
            // Response has: chunks[], metrics: { pageCount, processingTimeMs }, status, etc.

            const chunks = extendAIResponse.chunks || [];
            const metrics = extendAIResponse.metrics || {};
            const pageCount = metrics.pageCount || 0;
            const processingTimeMs = metrics.processingTimeMs || 0;
            const extractionTimeSeconds = processingTimeMs / 1000; // Convert ms to seconds

            // Extract text and markdown from chunks
            let fullText = '';
            let fullMarkdown = '';
            const pages = [];
            const tables = [];

            // Process chunks to extract content
            for (const chunk of chunks) {
                if (chunk.type === 'page') {
                    // Extract page content
                    const pageContent = chunk.content || '';
                    const pageRange = chunk.metadata?.pageRange || {};
                    const pageNumber = pageRange.start || pageRange.end || pages.length + 1;

                    // Add to full text/markdown
                    fullMarkdown += pageContent + '\n\n';
                    fullText += pageContent + '\n\n';

                    // Add to pages array
                    pages.push({
                        page_number: pageNumber,
                        text: pageContent
                    });
                } else if (chunk.type === 'table') {
                    // Extract table content
                    const tableContent = chunk.content || '';
                    tables.push({
                        content: tableContent,
                        metadata: chunk.metadata || {}
                    });
                } else {
                    // Other chunk types (text, heading, etc.) - add to full content
                    const content = chunk.content || '';
                    fullMarkdown += content + '\n\n';
                    fullText += content + '\n\n';
                }
            }

            // If no pages were extracted but we have pageCount, create placeholder pages
            if (pages.length === 0 && pageCount > 0) {
                for (let i = 1; i <= pageCount; i++) {
                    pages.push({
                        page_number: i,
                        text: ''
                    });
                }
            }

            // Trim whitespace
            fullText = fullText.trim();
            fullMarkdown = fullMarkdown.trim();

            return {
                success: true,
                text: fullText,
                markdown: fullMarkdown,
                pages: pages,
                tables: tables,
                method: 'extendai',
                extraction_time_seconds: extractionTimeSeconds,
                metadata: {
                    extraction_method: 'extendai',
                    total_pages: pages.length || pageCount,
                    total_tables: tables.length,
                    text_length: fullText.length,
                    markdown_length: fullMarkdown.length,
                    filename: filename,
                    parser_run_id: extendAIResponse.id,
                    file_id: extendAIResponse.fileId,
                    status: extendAIResponse.status
                }
            };

        } catch (error) {
            console.error('❌ Error converting ExtendAI response:', error.message);
            console.error('Response structure:', JSON.stringify(extendAIResponse, null, 2).substring(0, 500));
            throw new Error(`Failed to parse ExtendAI response: ${error.message}`);
        }
    }

    /**
     * Extract text from S3 file using ExtendAI
     * @param {string} s3Key - S3 key of the file
     * @param {string} filename - Original filename
     * @param {Function} getSignedUrlFn - Function to generate signed URL: (s3Key) => Promise<string>
     * @returns {Promise<Object>} Extraction result
     */
    async extractFromS3(s3Key, filename, getSignedUrlFn) {
        try {
            console.log(`📦 Generating signed URL for S3 file: ${s3Key}`);

            // Generate signed URL (expires in 1 hour)
            const signedUrl = await getSignedUrlFn(s3Key, 3600);

            console.log(`✅ Signed URL generated, calling ExtendAI...`);

            // Parse using ExtendAI
            return await this.parseFromUrl(signedUrl, filename);

        } catch (error) {
            console.error(`❌ Error extracting from S3 with ExtendAI:`, error.message);
            throw error;
        }
    }
}

export default ExtendAIService;

