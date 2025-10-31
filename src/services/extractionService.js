import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import ExtendAIService from './extendAIService.js';

const FLASK_URL = process.env.FLASK_URL || "http://localhost:5001";

class ExtractionService {
    constructor(s3Service = null) {
        this.flaskUrl = FLASK_URL;
        this.extendAIService = new ExtendAIService();
        this.s3Service = s3Service; // Will be injected for S3 operations
    }

    /**
     * Extract text from PDF using the specified method
     * @param {string} filePath - Path to the PDF file
     * @param {string} filename - Original filename
     * @param {string} method - Extraction method ('mineru', 'documentai', or 'extendai')
     * @param {Object} options - Method-specific options
     * @param {string} s3Key - Optional S3 key if file is in S3 (required for extendai)
     * @returns {Promise<Object>} Extraction result
     */
    async extractText(filePath, filename, method = 'mineru', options = {}, s3Key = null) {
        try {
            console.log(`📄 Extracting text using ${method} method for ${filename}`);

            // Handle ExtendAI extraction (requires S3 signed URL)
            if (method === 'extendai') {
                return await this.extractWithExtendAI(filename, s3Key, options);
            }

            // Fall through to Flask service for mineru/documentai

            const FormData = (await import('form-data')).default;
            const formData = new FormData();
            formData.append("file", fs.createReadStream(filePath), {
                filename: filename,
                contentType: "application/pdf",
            });

            // Add extraction method parameter
            formData.append("extraction_method", method);

            // Add any method-specific options
            if (Object.keys(options).length > 0) {
                formData.append("extraction_options", JSON.stringify(options));
            }

            console.log(`🌐 Calling Flask service: ${this.flaskUrl}/extract`);
            const response = await axios.post(`${this.flaskUrl}/extract`, formData, {
                headers: {
                    ...formData.getHeaders(),
                },
                timeout: 2 * 1200000, // 40 minutes timeout for large files
            });

            if (!response.data.success) {
                throw new Error(`Flask extraction failed: ${response.data.error}`);
            }

            const documentData = response.data.data;
            const markdown = documentData.markdown || "";
            const rawText = documentData.full_text || "";
            const pages = documentData.pages || [];
            const tables = documentData.tables || [];
            const extraction_time_seconds = response.data.extraction_time_seconds || 0;

            console.log(`✅ Extraction completed using ${method}: ${pages.length} pages, ${tables.length} tables, ${rawText.length} chars raw text, ${markdown.length} chars markdown`);

            return {
                success: true,
                text: rawText,
                tables: tables,
                markdown: markdown,
                pages: pages,
                method: method,
                extraction_time_seconds: extraction_time_seconds,
                metadata: {
                    extraction_method: method,
                    extraction_options: options,
                    total_pages: pages.length,
                    total_tables: tables.length,
                    text_length: rawText.length,
                    markdown_length: markdown.length
                }
            };

        } catch (error) {
            console.error(`❌ Extraction error with ${method}:`, error.message);
            return {
                success: false,
                error: error.message,
                method: method
            };
        }
    }

    /**
     * Extract text using ExtendAI with fallback to mineru
     * @param {string} filename - Original filename
     * @param {string} s3Key - S3 key of the file
     * @param {Object} options - Extraction options
     * @returns {Promise<Object>} Extraction result
     */
    async extractWithExtendAI(filename, s3Key, options = {}) {
        // Try ExtendAI first
        try {
            if (!s3Key || !this.s3Service) {
                throw new Error('S3 key and S3Service required for ExtendAI extraction');
            }

            if (!this.extendAIService.isConfigured()) {
                console.warn('⚠️ ExtendAI not configured, falling back to mineru');
                throw new Error('ExtendAI not configured');
            }

            console.log(`🚀 Attempting ExtendAI extraction for ${filename}`);

            // Generate signed URL and extract with ExtendAI
            const result = await this.extendAIService.extractFromS3(
                s3Key,
                filename,
                (key, expiresIn) => this.s3Service.generateSignedUrl(key, expiresIn)
            );

            console.log(`✅ ExtendAI extraction successful for ${filename}`);
            return result;

        } catch (extendAIError) {
            console.warn(`⚠️ ExtendAI extraction failed: ${extendAIError.message}`);
            console.log(`🔄 Falling back to mineru for ${filename}`);

            // Fallback to mineru
            // Note: For fallback, we'd need the file path
            // Since we only have S3 key, we need to download it first
            // Or handle this in the calling code
            return {
                success: false,
                error: `ExtendAI failed: ${extendAIError.message}. Please retry with mineru method.`,
                method: 'extendai',
                fallback_available: true,
                fallback_method: 'mineru'
            };
        }
    }

    /**
     * Extract with fallback: try extendai, fallback to mineru
     * @param {string} filePath - Path to local file (for mineru fallback)
     * @param {string} filename - Original filename
     * @param {string} s3Key - S3 key (for extendai)
     * @param {Object} options - Extraction options
     * @returns {Promise<Object>} Extraction result
     */
    async extractWithFallback(filePath, filename, s3Key, options = {}) {
        // Try ExtendAI first
        const extendAIResult = await this.extractWithExtendAI(filename, s3Key, options);

        if (extendAIResult.success) {
            return extendAIResult;
        }

        // Fallback to mineru
        console.log(`📄 Falling back to mineru extraction for ${filename}`);
        return await this.extractText(filePath, filename, 'mineru', options);
    }

    /**
     * Get available extraction methods
     * @returns {Array<string>} List of available methods
     */
    getAvailableMethods() {
        const methods = ['mineru', 'documentai'];
        if (this.extendAIService.isConfigured()) {
            methods.push('extendai');
        }
        return methods;
    }

    /**
     * Get default options for a specific method
     * @param {string} method - Extraction method
     * @returns {Object} Default options for the method
     */
    getDefaultOptions(method) {
        const defaultOptions = {
            mineru: {
                preserveFormatting: true,
                extractTables: true,
                extractImages: false
            },
            documentai: {
                extractTables: true,
                extractImages: false,
                confidenceThreshold: 0.8
            },
            extendai: {
                extractTables: true,
                extractImages: false
            }
        };

        return defaultOptions[method] || {};
    }
}

export default ExtractionService;
