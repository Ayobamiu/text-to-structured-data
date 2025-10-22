import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';

const FLASK_URL = process.env.FLASK_URL || "http://localhost:5001";

class ExtractionService {
    constructor() {
        this.flaskUrl = FLASK_URL;
    }

    /**
     * Extract text from PDF using the specified method
     * @param {string} filePath - Path to the PDF file
     * @param {string} filename - Original filename
     * @param {string} method - Extraction method ('mineru' or 'documentai')
     * @param {Object} options - Method-specific options
     * @returns {Promise<Object>} Extraction result
     */
    async extractText(filePath, filename, method = 'mineru', options = {}) {
        try {
            console.log(`📄 Extracting text using ${method} method for ${filename}`);

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
     * Get available extraction methods
     * @returns {Array<string>} List of available methods
     */
    getAvailableMethods() {
        return ['mineru', 'documentai'];
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
            }
        };

        return defaultOptions[method] || {};
    }
}

export default ExtractionService;
